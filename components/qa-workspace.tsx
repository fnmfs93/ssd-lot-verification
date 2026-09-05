"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import jsQR from "jsqr";
import type { AuthUser } from "@/lib/auth/session";
import {
  extractCandidateCodes,
  extractPartNumberCandidates,
  extractSessionIdCandidates,
} from "@/lib/ocr/code-matching";
import {
  captureVideoRegion,
  preprocessForOcr,
  recognizeCanvas,
  terminateBrowserOcrWorker,
} from "@/lib/ocr/browser-ocr";

// The label wizard walks through these four fields in one continuous camera
// session — the operator just re-frames the phone at each field in turn,
// nothing to tap between steps.
type LabelWizardStage = "sessionId" | "partNumber" | "firstBoxCodes" | "lastBoxCodes";

const LABEL_STAGE_SEQUENCE: LabelWizardStage[] = [
  "sessionId",
  "partNumber",
  "firstBoxCodes",
  "lastBoxCodes",
];

// Fractions of the camera frame each stage's guide box covers — kept as
// constants so the visual overlay and the actual OCR crop region can never
// drift apart. The 2D Code column is a narrow tall column (reused for both
// boxes); Session ID / Part Number are short wide lines near the top.
const CODE_GUIDE_REGION = { left: 0.04, top: 0.04, width: 0.4, height: 0.48 };
const LINE_GUIDE_REGION = { left: 0.06, top: 0.08, width: 0.72, height: 0.16 };

const LABEL_STAGE_CONFIG: Record<
  LabelWizardStage,
  { title: string; hint: string; guideRegion: typeof CODE_GUIDE_REGION }
> = {
  sessionId: {
    title: "Session ID",
    hint: "Frame the Session ID (e.g. 20260801-0001) inside the box.",
    guideRegion: LINE_GUIDE_REGION,
  },
  partNumber: {
    title: "Part Number",
    hint: "Frame the Part Number (e.g. M034-002816) inside the box.",
    guideRegion: LINE_GUIDE_REGION,
  },
  firstBoxCodes: {
    title: "First Box — 2D Codes",
    hint: "Frame the First Box label's 2D Code column inside the box.",
    guideRegion: CODE_GUIDE_REGION,
  },
  lastBoxCodes: {
    title: "Last Box — 2D Codes",
    hint: "Swap to the Last Box label, then frame its 2D Code column.",
    guideRegion: CODE_GUIDE_REGION,
  },
};

const LABEL_SCAN_INTERVAL_MS = 400;
const LABEL_SCAN_MAX_ATTEMPTS = 25;
// How many consecutive attempts must pass with no *new* result appearing
// before a stage is considered done. Results accumulate across a stage's
// attempts (a single frame doesn't always read cleanly), so "finished"
// means discovery has plateaued, not that the exact result repeated once.
const LABEL_SCAN_PLATEAU_ATTEMPTS = 3;

const SESSION_ID_PATTERN = /^\d{8}-\d{4}$/;
const PART_NUMBER_PATTERN = /^[A-Z]\d{3}-\d{6}$/;

type BarcodeDetectorLike = {
  detect(image: ImageBitmapSource): Promise<Array<{ rawValue?: string }>>;
};

declare global {
  interface Window {
    BarcodeDetector?: {
      new (options?: { formats?: string[] }): BarcodeDetectorLike;
      getSupportedFormats?: () => Promise<string[]>;
    };
  }
}

type VerificationRecord = {
  id: string;
  scannedQrValue: string;
  result: "matched" | "unmatched";
  matchedLabelCode: string | null;
  matchedBoxLabel: "first" | "last" | null;
  matchedSerialIndex: number | null;
  verifiedAt: string;
};

type SessionState = {
  sessionKey: string;
  sessionIdCode: string;
  partNumber: string;
  firstBoxCodes: string[];
  lastBoxCodes: string[];
  storageMode: string;
};

type ReportOutcome = "pass" | "fail";

function parseManualCodes(value: string) {
  return [...new Set(value.toUpperCase().match(/\b[A-Z0-9]{11}\b/g) ?? [])];
}

export function QaWorkspace({ user }: { user: AuthUser }) {
  const router = useRouter();
  const labelVideoRef = useRef<HTMLVideoElement | null>(null);
  const partVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanLoopRef = useRef<number | null>(null);
  const submitTimeoutRef = useRef<number | null>(null);
  const lastSubmittedValueRef = useRef<string>("");

  const labelScanActiveRef = useRef(false);
  const labelScanTimeoutRef = useRef<number | null>(null);
  const labelScanTextsRef = useRef<string[]>([]);
  const labelScanPrevResultRef = useRef<string[]>([]);
  const labelScanStableCountRef = useRef(0);
  const labelScanAttemptCountRef = useRef(0);
  const labelStageRef = useRef<LabelWizardStage>("sessionId");
  const allStagesRawTextRef = useRef<string[]>([]);
  const isRescanOnlyRef = useRef(false);
  const rescanStageRef = useRef<LabelWizardStage | null>(null);

  const [session, setSession] = useState<SessionState | null>(null);
  const [history, setHistory] = useState<VerificationRecord[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("Ready for a new label session.");
  const [isUploading, setIsUploading] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [cameraMode, setCameraMode] = useState<"label" | "part" | null>(null);
  const [labelStage, setLabelStage] = useState<LabelWizardStage>("sessionId");
  const [isRescanMode, setIsRescanMode] = useState(false);
  const [lastResult, setLastResult] = useState<VerificationRecord | null>(null);
  const [partScanValue, setPartScanValue] = useState("");
  const [showCodes, setShowCodes] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [remarksInput, setRemarksInput] = useState("");

  // Populated once the 4-stage scan finishes; reviewed/correctable before
  // saving the label session.
  const [isReviewReady, setIsReviewReady] = useState(false);
  const [scannedSessionId, setScannedSessionId] = useState("");
  const [scannedPartNumber, setScannedPartNumber] = useState("");
  const [scannedFirstBoxCodes, setScannedFirstBoxCodes] = useState<string[]>([]);
  const [scannedLastBoxCodes, setScannedLastBoxCodes] = useState<string[]>([]);
  // Captured silently for image storage — never shown in the UI, just the
  // scanned values (same as Session ID / Part Number).
  const [firstBoxFile, setFirstBoxFile] = useState<File | null>(null);
  const [lastBoxFile, setLastBoxFile] = useState<File | null>(null);
  const [firstBoxManualCodes, setFirstBoxManualCodes] = useState("");
  const [lastBoxManualCodes, setLastBoxManualCodes] = useState("");
  const [failedOcrPreview, setFailedOcrPreview] = useState("");

  const [reportOutcome, setReportOutcome] = useState<ReportOutcome | null>(null);
  const [reportSent, setReportSent] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  const firstBoxManualCount = useMemo(
    () => parseManualCodes(firstBoxManualCodes).length,
    [firstBoxManualCodes],
  );
  const lastBoxManualCount = useMemo(
    () => parseManualCodes(lastBoxManualCodes).length,
    [lastBoxManualCodes],
  );

  const canSaveSession =
    SESSION_ID_PATTERN.test(scannedSessionId) &&
    PART_NUMBER_PATTERN.test(scannedPartNumber) &&
    (scannedFirstBoxCodes.length > 0 || firstBoxManualCount > 0) &&
    (scannedLastBoxCodes.length > 0 || lastBoxManualCount > 0) &&
    Boolean(firstBoxFile) &&
    Boolean(lastBoxFile);

  const slotStatuses = useMemo(() => {
    if (!session) {
      return [];
    }

    const slots: Array<{ box: "first" | "last"; serialIndex: number; codeValue: string }> = [
      ...session.firstBoxCodes.map((codeValue, index) => ({
        box: "first" as const,
        serialIndex: index + 1,
        codeValue,
      })),
      ...session.lastBoxCodes.map((codeValue, index) => ({
        box: "last" as const,
        serialIndex: index + 1,
        codeValue,
      })),
    ];

    return slots.map((slot) => ({
      ...slot,
      match:
        history.find(
          (item) =>
            item.result === "matched" &&
            item.matchedBoxLabel === slot.box &&
            item.matchedSerialIndex === slot.serialIndex,
        ) ?? null,
    }));
  }, [session, history]);

  useEffect(() => {
    const video =
      cameraMode === "label" ? labelVideoRef.current : partVideoRef.current;

    if (!isCameraOpen || !video || !streamRef.current) {
      return;
    }

    video.srcObject = streamRef.current;
    video.muted = true;
    video.playsInline = true;

    const playVideo = async () => {
      try {
        await video.play();

        if (cameraMode === "label") {
          if (isRescanOnlyRef.current && rescanStageRef.current) {
            setStage(rescanStageRef.current);
            labelScanActiveRef.current = true;
            scheduleNextLabelScan();
          } else {
            startLabelScanLoop();
          }
        }
      } catch {
        setCameraError(
          "Camera preview could not start on this device. Try reopening the camera or use file upload / scanner input instead.",
        );
      }
    };

    void playVideo();
  }, [cameraMode, isCameraOpen]);

  useEffect(() => {
    return () => {
      stopCamera();
      void terminateBrowserOcrWorker();

      if (submitTimeoutRef.current) {
        window.clearTimeout(submitTimeoutRef.current);
      }
    };
  }, []);

  function stopCamera() {
    if (scanLoopRef.current) {
      window.cancelAnimationFrame(scanLoopRef.current);
      scanLoopRef.current = null;
    }

    labelScanActiveRef.current = false;

    if (labelScanTimeoutRef.current) {
      window.clearTimeout(labelScanTimeoutRef.current);
      labelScanTimeoutRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (labelVideoRef.current) {
      labelVideoRef.current.srcObject = null;
    }

    if (partVideoRef.current) {
      partVideoRef.current.srcObject = null;
    }

    setIsCameraOpen(false);
    setCameraMode(null);
  }

  async function captureVideoFrame(video: HTMLVideoElement) {
    // No forced rotation: send the frame exactly as framed on screen. The
    // OCR pipeline already tries 0/90/270 degree rotations, and a forced
    // client-side rotation made the captured preview look sideways relative
    // to what the guide box promised.
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1920;
    canvas.height = video.videoHeight || 1080;

    const context = canvas.getContext("2d");

    if (!context) {
      return null;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    return canvas;
  }

  async function cropCanvasToContent(canvas: HTMLCanvasElement) {
    const width = canvas.width;
    const height = canvas.height;
    const context = canvas.getContext("2d");

    if (!context) {
      return canvas;
    }

    const imageData = context.getImageData(0, 0, width, height);
    const { data } = imageData;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const red = data[index];
        const green = data[index + 1];
        const blue = data[index + 2];
        const brightness = (red + green + blue) / 3;

        if (brightness < 235) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < minX || maxY < minY) {
      return canvas;
    }

    const padding = 24;
    const cropX = Math.max(0, minX - padding);
    const cropY = Math.max(0, minY - padding);
    const cropWidth = Math.min(width - cropX, maxX - minX + 1 + padding * 2);
    const cropHeight = Math.min(height - cropY, maxY - minY + 1 + padding * 2);
    const croppedCanvas = document.createElement("canvas");

    croppedCanvas.width = cropWidth;
    croppedCanvas.height = cropHeight;

    const croppedContext = croppedCanvas.getContext("2d");

    if (!croppedContext) {
      return canvas;
    }

    croppedContext.drawImage(
      canvas,
      cropX,
      cropY,
      cropWidth,
      cropHeight,
      0,
      0,
      cropWidth,
      cropHeight,
    );

    return croppedCanvas;
  }

  async function handleLogout() {
    stopCamera();
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  function resetLabelWizardState() {
    setIsReviewReady(false);
    setScannedSessionId("");
    setScannedPartNumber("");
    setScannedFirstBoxCodes([]);
    setScannedLastBoxCodes([]);
    setFirstBoxManualCodes("");
    setLastBoxManualCodes("");
    setFirstBoxFile(null);
    setLastBoxFile(null);
    allStagesRawTextRef.current = [];
  }

  async function handleStartLabelCamera() {
    setCameraError(null);
    setUploadError(null);
    setFailedOcrPreview("");
    resetLabelWizardState();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });

      stopCamera();
      streamRef.current = stream;

      setIsCameraOpen(true);
      setCameraMode("label");
      setStatus("Camera ready. Scanning Session ID first — keep the camera open through all 4 steps.");
    } catch {
      setCameraError(
        "Camera access failed. Check browser permissions and try again.",
      );
    }
  }

  function setStage(stage: LabelWizardStage) {
    labelStageRef.current = stage;
    setLabelStage(stage);
    labelScanTextsRef.current = [];
    labelScanPrevResultRef.current = [];
    labelScanStableCountRef.current = 0;
    labelScanAttemptCountRef.current = 0;
  }

  function handleCancelLabelScan() {
    const wasRescan = isRescanOnlyRef.current;
    stopCamera();
    isRescanOnlyRef.current = false;
    rescanStageRef.current = null;
    setIsRescanMode(false);

    if (wasRescan) {
      // Cancelling a targeted rescan should return to the review screen
      // with the previous value intact, not strand the user on a blank
      // "Open Camera" state.
      setIsReviewReady(true);
      setStatus("Rescan cancelled — previous value kept.");
    }
  }

  function startLabelScanLoop() {
    isRescanOnlyRef.current = false;
    rescanStageRef.current = null;
    setIsRescanMode(false);
    setStage("sessionId");
    labelScanActiveRef.current = true;
    scheduleNextLabelScan();
  }

  function scheduleNextLabelScan() {
    if (!labelScanActiveRef.current) {
      return;
    }

    labelScanTimeoutRef.current = window.setTimeout(() => {
      void runLabelScanAttempt();
    }, LABEL_SCAN_INTERVAL_MS);
  }

  function extractForStage(stage: LabelWizardStage, texts: string[]) {
    if (stage === "sessionId") {
      return extractSessionIdCandidates(texts, { minTotalCount: 2 });
    }

    if (stage === "partNumber") {
      return extractPartNumberCandidates(texts, { minTotalCount: 2 });
    }

    return extractCandidateCodes(texts, { minTotalCount: 2 });
  }

  async function runLabelScanAttempt() {
    const video = labelVideoRef.current;
    const stage = labelStageRef.current;

    if (!labelScanActiveRef.current || !video || video.readyState < 2 || !video.videoWidth) {
      scheduleNextLabelScan();
      return;
    }

    const guideRegion = LABEL_STAGE_CONFIG[stage].guideRegion;
    const region = {
      left: video.videoWidth * guideRegion.left,
      top: video.videoHeight * guideRegion.top,
      width: video.videoWidth * guideRegion.width,
      height: video.videoHeight * guideRegion.height,
    };

    const regionCanvas = captureVideoRegion(video, region);

    if (regionCanvas) {
      preprocessForOcr(regionCanvas);

      try {
        const text = await recognizeCanvas(regionCanvas);
        labelScanTextsRef.current.push(text);
      } catch {
        // A single failed OCR pass isn't fatal — just try again next tick.
      }
    }

    labelScanAttemptCountRef.current += 1;

    if (!labelScanActiveRef.current || labelStageRef.current !== stage) {
      // Scanning was stopped, or a stage change already happened while this
      // pass was in flight.
      return;
    }

    // Require every candidate to be seen at least twice across this stage's
    // attempts — filters a one-off misread from a moment of camera drift
    // without needing to discard real accumulated evidence.
    const results = extractForStage(stage, labelScanTextsRef.current);
    const previous = labelScanPrevResultRef.current;
    const grew = results.some((value) => !previous.includes(value));

    labelScanPrevResultRef.current = results;
    labelScanStableCountRef.current =
      grew || results.length === 0 ? 0 : labelScanStableCountRef.current + 1;

    const isStable = labelScanStableCountRef.current >= LABEL_SCAN_PLATEAU_ATTEMPTS;

    if (
      (results.length > 0 && isStable) ||
      labelScanAttemptCountRef.current >= LABEL_SCAN_MAX_ATTEMPTS
    ) {
      await handleStageResult(stage, results, labelScanTextsRef.current);
      return;
    }

    const found =
      stage === "firstBoxCodes" || stage === "lastBoxCodes"
        ? `found ${results.length} code${results.length === 1 ? "" : "s"}`
        : results[0]
          ? `read "${results[0]}"`
          : "still reading";

    setStatus(`Scanning ${LABEL_STAGE_CONFIG[stage].title}... ${found}. Keep the label steady.`);
    scheduleNextLabelScan();
  }

  async function captureBoxPhoto(): Promise<File | null> {
    const video = labelVideoRef.current;
    const baseCanvas = video ? await captureVideoFrame(video) : null;
    const canvas = baseCanvas ? await cropCanvasToContent(baseCanvas) : null;

    if (!canvas) {
      return null;
    }

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.92);
    });

    if (!blob) {
      return null;
    }

    return new File([blob], `label-${Date.now()}.jpg`, { type: "image/jpeg" });
  }

  function applyStageResult(stage: LabelWizardStage, results: string[]) {
    if (stage === "sessionId") {
      setScannedSessionId(results[0] ?? "");
    } else if (stage === "partNumber") {
      setScannedPartNumber(results[0] ?? "");
    } else if (stage === "firstBoxCodes") {
      setScannedFirstBoxCodes(results);
    } else {
      setScannedLastBoxCodes(results);
    }
  }

  async function handleStageResult(stage: LabelWizardStage, results: string[], texts: string[]) {
    allStagesRawTextRef.current.push(texts.join("\n\n--- SCAN ---\n\n"));

    // The photo is captured silently for image storage/audit — it's never
    // shown in the review UI, just the scanned values (same as Session ID /
    // Part Number).
    if (stage === "firstBoxCodes" || stage === "lastBoxCodes") {
      const file = await captureBoxPhoto();

      if (stage === "firstBoxCodes") {
        setFirstBoxFile(file);
      } else {
        setLastBoxFile(file);
      }
    }

    applyStageResult(stage, results);

    if (isRescanOnlyRef.current) {
      // Targeted rescan of a single field — no need to redo the whole
      // 4-stage flow. Update just this field and drop straight back to
      // review.
      isRescanOnlyRef.current = false;
      rescanStageRef.current = null;
      setIsRescanMode(false);
      stopCamera();
      setIsReviewReady(true);
      setStatus(`${LABEL_STAGE_CONFIG[stage].title} rescanned — review below.`);
      return;
    }

    const nextIndex = LABEL_STAGE_SEQUENCE.indexOf(stage) + 1;

    if (nextIndex >= LABEL_STAGE_SEQUENCE.length) {
      stopCamera();
      setIsReviewReady(true);
      setStatus("Scan complete. Review the details below and save the label session.");
      return;
    }

    const nextStage = LABEL_STAGE_SEQUENCE[nextIndex];
    setStage(nextStage);
    setStatus(
      `${LABEL_STAGE_CONFIG[stage].title} captured. Now: ${LABEL_STAGE_CONFIG[nextStage].hint}`,
    );
    scheduleNextLabelScan();
  }

  async function handleRescanField(stage: LabelWizardStage) {
    setCameraError(null);
    isRescanOnlyRef.current = true;
    rescanStageRef.current = stage;
    setIsRescanMode(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });

      stopCamera();
      streamRef.current = stream;
      setIsReviewReady(false);
      setIsCameraOpen(true);
      setCameraMode("label");
      setStatus(`Rescanning ${LABEL_STAGE_CONFIG[stage].title}...`);
    } catch {
      isRescanOnlyRef.current = false;
      rescanStageRef.current = null;
      setIsRescanMode(false);
      setIsReviewReady(true);
      setCameraError("Camera access failed. Check browser permissions and try again.");
    }
  }

  async function handleStartPartCamera() {
    if (!session) {
      setVerifyError("Save a label session first before scanning part QR codes.");
      return;
    }

    setCameraError(null);
    setVerifyError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });

      stopCamera();
      streamRef.current = stream;

      setIsCameraOpen(true);
      setCameraMode("part");
      setStatus(
        "Part camera ready. Move very close to the QR and keep steady. Small 2mm codes may still be unreliable on some phones.",
      );

      // Prefer the native Shape Detection API where available (Chrome/Edge on
      // Android); fall back to jsQR's canvas-based decoder for browsers that
      // don't ship it at all, e.g. Safari/iOS.
      const nativeDetector = window.BarcodeDetector
        ? new window.BarcodeDetector({ formats: ["qr_code"] })
        : null;
      const scanCanvas = document.createElement("canvas");
      const scanContext = scanCanvas.getContext("2d", { willReadFrequently: true });

      const detectQrValue = async (video: HTMLVideoElement) => {
        if (nativeDetector) {
          const barcodes = await nativeDetector.detect(video);
          return barcodes.find((item) => item.rawValue?.trim())?.rawValue ?? null;
        }

        if (!scanContext || !video.videoWidth || !video.videoHeight) {
          return null;
        }

        const maxDimension = 720;
        const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
        const width = Math.max(1, Math.round(video.videoWidth * scale));
        const height = Math.max(1, Math.round(video.videoHeight * scale));

        scanCanvas.width = width;
        scanCanvas.height = height;
        scanContext.drawImage(video, 0, 0, width, height);

        const imageData = scanContext.getImageData(0, 0, width, height);
        const result = jsQR(imageData.data, width, height, { inversionAttempts: "attemptBoth" });

        return result?.data ?? null;
      };

      const scanFrame = async () => {
        const video = partVideoRef.current;

        if (!video || video.readyState < 2 || isVerifying) {
          scanLoopRef.current = window.requestAnimationFrame(scanFrame);
          return;
        }

        try {
          const rawValue = await detectQrValue(video);

          if (rawValue?.trim()) {
            const detectedValue = rawValue.trim().toUpperCase();
            setPartScanValue(detectedValue);
            stopCamera();
            setStatus("QR detected. Verifying automatically...");
            await submitPartVerification(detectedValue);
            return;
          }
        } catch {
          setCameraError(
            "Live QR scanning failed on this device. Use scanner gun or manual entry as fallback.",
          );
          stopCamera();
          return;
        }

        scanLoopRef.current = window.requestAnimationFrame(scanFrame);
      };

      scanLoopRef.current = window.requestAnimationFrame(scanFrame);
    } catch {
      setCameraError(
        "Part camera access failed. Check browser permissions or use scanner gun/manual entry instead.",
      );
    }
  }

  async function submitPartVerification(scannedQrValue: string) {
    if (!session) {
      setVerifyError("Save a label session first.");
      return;
    }

    if (reportOutcome) {
      setVerifyError("This session is already closed out. Start a new label session to continue.");
      return;
    }

    const normalizedValue = scannedQrValue.trim().toUpperCase();

    if (!normalizedValue) {
      setVerifyError("Scan or enter a QR value first.");
      return;
    }

    if (isVerifying) {
      return;
    }

    if (lastSubmittedValueRef.current === normalizedValue) {
      return;
    }

    setVerifyError(null);
    setIsVerifying(true);
    lastSubmittedValueRef.current = normalizedValue;

    const response = await fetch("/api/part-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionKey: session.sessionKey,
        scannedQrValue: normalizedValue,
        remarks: remarksInput,
      }),
    });

    const data = (await response.json().catch(() => null)) as
      | {
          error?: string;
          id?: string;
          scannedQrValue?: string;
          result?: "matched" | "unmatched";
          matchedLabelCode?: string | null;
          matchedBoxLabel?: "first" | "last" | null;
          matchedSerialIndex?: number | null;
          verifiedAt?: string;
          sessionComplete?: boolean;
          reportSent?: boolean;
          reportError?: string | null;
        }
      | null;

    setIsVerifying(false);

    if (
      !response.ok ||
      !data?.id ||
      !data.result ||
      !data.scannedQrValue ||
      !data.verifiedAt
    ) {
      lastSubmittedValueRef.current = "";
      setVerifyError(data?.error ?? "Verification failed.");
      setPartScanValue(normalizedValue);
      return;
    }

    const record: VerificationRecord = {
      id: data.id,
      scannedQrValue: data.scannedQrValue,
      result: data.result,
      matchedLabelCode: data.matchedLabelCode ?? null,
      matchedBoxLabel: data.matchedBoxLabel ?? null,
      matchedSerialIndex: data.matchedSerialIndex ?? null,
      verifiedAt: data.verifiedAt,
    };

    setLastResult(record);
    setHistory((current) => [record, ...current]);

    if (data.sessionComplete) {
      setReportOutcome("pass");
      setReportSent(Boolean(data.reportSent));
      setReportError(data.reportSent ? null : data.reportError ?? "Failed to send report.");
      setStatus("All 6 codes matched — PASS.");
    } else {
      setStatus(
        record.result === "matched"
          ? `Matched ${record.matchedBoxLabel === "first" ? "First" : "Last"} Box Serial ${record.matchedSerialIndex}.`
          : "Part does not belong to this label.",
      );
    }

    setPartScanValue("");
    lastSubmittedValueRef.current = "";
  }

  async function handleFailSession() {
    if (!session) {
      return;
    }

    const confirmed = window.confirm(
      "Mark this session as FAILED and email the report now? This can't be undone.",
    );

    if (!confirmed) {
      return;
    }

    setIsFinalizing(true);
    setVerifyError(null);

    const response = await fetch("/api/label-session/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionKey: session.sessionKey,
        outcome: "fail",
        remarks: remarksInput,
      }),
    });

    const data = (await response.json().catch(() => null)) as
      | { error?: string; reportSent?: boolean }
      | null;

    setIsFinalizing(false);

    if (!response.ok) {
      setVerifyError(data?.error ?? "Failed to send the report.");
      return;
    }

    setReportOutcome("fail");
    setReportSent(Boolean(data?.reportSent));
    setReportError(data?.reportSent ? null : data?.error ?? "Failed to send the report.");
    setStatus("Session marked FAILED.");
  }

  async function handleRetrySendReport() {
    if (!session || !reportOutcome) {
      return;
    }

    setIsFinalizing(true);

    const response = await fetch("/api/label-session/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionKey: session.sessionKey,
        outcome: reportOutcome,
        remarks: remarksInput,
      }),
    });

    const data = (await response.json().catch(() => null)) as
      | { error?: string; reportSent?: boolean }
      | null;

    setIsFinalizing(false);

    if (!response.ok) {
      setReportError(data?.error ?? "Failed to send the report.");
      return;
    }

    setReportSent(Boolean(data?.reportSent));
    setReportError(data?.reportSent ? null : data?.error ?? "Failed to send the report.");
  }

  function queueAutoSubmit(nextValue: string) {
    if (!session) {
      return;
    }

    if (submitTimeoutRef.current) {
      window.clearTimeout(submitTimeoutRef.current);
      submitTimeoutRef.current = null;
    }

    const normalizedValue = nextValue.trim().toUpperCase();

    if (!normalizedValue) {
      return;
    }

    submitTimeoutRef.current = window.setTimeout(() => {
      submitTimeoutRef.current = null;
      void submitPartVerification(normalizedValue);
    }, 120);
  }

  async function handleLabelSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUploadError(null);
    setFailedOcrPreview("");
    setLastResult(null);
    setHistory([]);
    setReportOutcome(null);
    setReportSent(false);
    setReportError(null);

    if (!firstBoxFile || !lastBoxFile) {
      setUploadError("Scan both the First Box and Last Box labels before saving.");
      return;
    }

    setIsUploading(true);
    setStatus("Saving label session...");

    const form = event.currentTarget;
    const formData = new FormData(form);

    formData.set("sourceType", "camera");
    formData.set("sessionIdCode", scannedSessionId);
    formData.set("partNumber", scannedPartNumber);
    formData.set("firstBoxFile", firstBoxFile);
    formData.set("lastBoxFile", lastBoxFile);
    formData.set("firstBoxCodes", JSON.stringify(scannedFirstBoxCodes));
    formData.set("lastBoxCodes", JSON.stringify(scannedLastBoxCodes));
    formData.set("firstBoxManualCodes", firstBoxManualCodes);
    formData.set("lastBoxManualCodes", lastBoxManualCodes);
    formData.set("rawOcrText", allStagesRawTextRef.current.join("\n\n=== STAGE ===\n\n"));

    const response = await fetch("/api/label-session", {
      method: "POST",
      body: formData,
    });

    const data = (await response.json().catch(() => null)) as
      | {
          error?: string;
          sessionKey?: string;
          sessionIdCode?: string;
          partNumber?: string;
          firstBoxCodes?: string[];
          lastBoxCodes?: string[];
          storageMode?: string;
          ocrPreview?: string;
        }
      | null;

    setIsUploading(false);

    if (!response.ok || !data?.sessionKey || !data.firstBoxCodes || !data.lastBoxCodes) {
      setUploadError(data?.error ?? "Label processing failed.");
      setFailedOcrPreview(data?.ocrPreview ?? "");
      setStatus("Waiting for a clearer label scan.");
      return;
    }

    setSession({
      sessionKey: data.sessionKey,
      sessionIdCode: data.sessionIdCode ?? scannedSessionId,
      partNumber: data.partNumber ?? scannedPartNumber,
      firstBoxCodes: data.firstBoxCodes,
      lastBoxCodes: data.lastBoxCodes,
      storageMode: data.storageMode ?? "unknown",
    });
    setShowCodes(false);
    setShowHistory(false);
    setFailedOcrPreview("");
    setRemarksInput("");
    resetLabelWizardState();
    form.reset();
    setStatus("Label session ready. Start scanning parts.");
  }

  async function handleVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (submitTimeoutRef.current) {
      window.clearTimeout(submitTimeoutRef.current);
      submitTimeoutRef.current = null;
    }

    await submitPartVerification(partScanValue);
  }

  const currentStageIndex = LABEL_STAGE_SEQUENCE.indexOf(labelStage);

  return (
    <main className="shell">
      <section className="hero">
        <div className="hero-top">
          <div>
            <div className="eyebrow">QA Workspace</div>
            <h1>Verify Many Parts Against One Label</h1>
            <p>
              Signed in as <strong>{user.name}</strong>. Scan the First Box and Last
              Box labels (Session ID, Part Number, and 3 codes each), then verify
              all 6 parts — a report emails automatically once every part matches.
            </p>
          </div>
          <button className="button secondary hero-signout" type="button" onClick={handleLogout}>
            Sign Out
          </button>
        </div>
      </section>

      <div className="grid">
        <div className="stack">
          <section className="card">
            <div className="split">
              <div>
                <div className="mobile-step">Step 1 · Label</div>
                <h2>1. Scan Label Session</h2>
                <p className="muted">
                  Point the camera at the First Box label, then the Last Box label.
                  Scanning advances through each field automatically.
                </p>
              </div>
            </div>

            <form onSubmit={handleLabelSubmit}>
              <div className="field">
                <label htmlFor="station">Station (optional)</label>
                <input id="station" name="station" type="text" placeholder="QA-01" />
              </div>

              {!isCameraOpen && !isReviewReady ? (
                <div className="button-row" style={{ marginBottom: 16 }}>
                  <button className="button ghost" type="button" onClick={handleStartLabelCamera}>
                    Open Camera
                  </button>
                </div>
              ) : null}

              {isCameraOpen && cameraMode === "label" ? (
                <div className="card" style={{ marginBottom: 16, padding: 16 }}>
                  <p className="muted" style={{ marginTop: 0 }}>
                    {isRescanMode ? (
                      <>
                        Rescanning: <strong>{LABEL_STAGE_CONFIG[labelStage].title}</strong>
                      </>
                    ) : (
                      <>
                        Step {currentStageIndex + 1} of {LABEL_STAGE_SEQUENCE.length}:{" "}
                        <strong>{LABEL_STAGE_CONFIG[labelStage].title}</strong>
                      </>
                    )}
                  </p>
                  <div
                    className="label-camera-frame"
                    style={{
                      position: "relative",
                      width: "100%",
                      borderRadius: 18,
                      overflow: "hidden",
                      background: "#000",
                    }}
                  >
                    <video
                      ref={labelVideoRef}
                      autoPlay
                      playsInline
                      muted
                      className="label-camera-video"
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                      }}
                    />
                    <div
                      className="label-camera-guide"
                      style={{
                        position: "absolute",
                        left: `${LABEL_STAGE_CONFIG[labelStage].guideRegion.left * 100}%`,
                        top: `${LABEL_STAGE_CONFIG[labelStage].guideRegion.top * 100}%`,
                        width: `${LABEL_STAGE_CONFIG[labelStage].guideRegion.width * 100}%`,
                        height: `${LABEL_STAGE_CONFIG[labelStage].guideRegion.height * 100}%`,
                        border: "3px dashed #4ade80",
                        borderRadius: 12,
                        boxSizing: "border-box",
                        pointerEvents: "none",
                      }}
                    />
                    <div
                      className="label-camera-hint"
                      style={{
                        position: "absolute",
                        left: 8,
                        right: 8,
                        bottom: 8,
                        color: "#fff",
                        background: "rgba(0, 0, 0, 0.6)",
                        padding: "6px 10px",
                        borderRadius: 8,
                        fontSize: 12,
                        lineHeight: 1.3,
                        textAlign: "center",
                        pointerEvents: "none",
                      }}
                    >
                      {LABEL_STAGE_CONFIG[labelStage].hint}
                    </div>
                  </div>
                  <div className="button-row" style={{ marginTop: 14 }}>
                    <button className="button secondary" type="button" onClick={handleCancelLabelScan}>
                      Cancel Scan
                    </button>
                  </div>
                </div>
              ) : null}

              {isReviewReady ? (
                <div className="card" style={{ marginBottom: 16, padding: 16 }}>
                  <p className="muted" style={{ marginTop: 0 }}>
                    Review the scanned details, correct anything that looks wrong,
                    then save.
                  </p>

                  <div className="field">
                    <div className="split">
                      <label htmlFor="sessionIdCode">Session ID</label>
                      <button
                        className="button ghost small"
                        type="button"
                        onClick={() => handleRescanField("sessionId")}
                      >
                        Rescan
                      </button>
                    </div>
                    <input
                      id="sessionIdCode"
                      type="text"
                      placeholder="20260801-0001"
                      value={scannedSessionId}
                      onChange={(event) => setScannedSessionId(event.target.value.toUpperCase())}
                    />
                    {!SESSION_ID_PATTERN.test(scannedSessionId) ? (
                      <small className="muted">Expected format: YYYYMMDD-NNNN</small>
                    ) : null}
                  </div>

                  <div className="field">
                    <div className="split">
                      <label htmlFor="partNumber">Part Number</label>
                      <button
                        className="button ghost small"
                        type="button"
                        onClick={() => handleRescanField("partNumber")}
                      >
                        Rescan
                      </button>
                    </div>
                    <input
                      id="partNumber"
                      type="text"
                      placeholder="M034-002816"
                      value={scannedPartNumber}
                      onChange={(event) => setScannedPartNumber(event.target.value.toUpperCase())}
                    />
                    {!PART_NUMBER_PATTERN.test(scannedPartNumber) ? (
                      <small className="muted">Expected format: LNNN-NNNNNN</small>
                    ) : null}
                  </div>

                  <div className="split" style={{ gap: 16, alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                      <div className="split">
                        <p className="muted" style={{ marginBottom: 4 }}>
                          <strong>First Box codes</strong> ({scannedFirstBoxCodes.length} found)
                        </p>
                        <button
                          className="button ghost small"
                          type="button"
                          onClick={() => handleRescanField("firstBoxCodes")}
                        >
                          Rescan
                        </button>
                      </div>
                      <div className="code-list">
                        {scannedFirstBoxCodes.map((code) => (
                          <div className="code-pill" key={code}>
                            <span className="mono">{code}</span>
                          </div>
                        ))}
                      </div>
                      <div className="field">
                        <label htmlFor="firstBoxManualCodes">Manual fallback</label>
                        <textarea
                          id="firstBoxManualCodes"
                          rows={3}
                          placeholder="Paste codes if scanning missed any"
                          value={firstBoxManualCodes}
                          onChange={(event) =>
                            setFirstBoxManualCodes(event.target.value.toUpperCase())
                          }
                        />
                      </div>
                    </div>

                    <div style={{ flex: 1 }}>
                      <div className="split">
                        <p className="muted" style={{ marginBottom: 4 }}>
                          <strong>Last Box codes</strong> ({scannedLastBoxCodes.length} found)
                        </p>
                        <button
                          className="button ghost small"
                          type="button"
                          onClick={() => handleRescanField("lastBoxCodes")}
                        >
                          Rescan
                        </button>
                      </div>
                      <div className="code-list">
                        {scannedLastBoxCodes.map((code) => (
                          <div className="code-pill" key={code}>
                            <span className="mono">{code}</span>
                          </div>
                        ))}
                      </div>
                      <div className="field">
                        <label htmlFor="lastBoxManualCodes">Manual fallback</label>
                        <textarea
                          id="lastBoxManualCodes"
                          rows={3}
                          placeholder="Paste codes if scanning missed any"
                          value={lastBoxManualCodes}
                          onChange={(event) =>
                            setLastBoxManualCodes(event.target.value.toUpperCase())
                          }
                        />
                      </div>
                    </div>
                  </div>

                  <div className="button-row" style={{ marginTop: 12 }}>
                    <button
                      className="button secondary"
                      type="button"
                      onClick={handleStartLabelCamera}
                    >
                      Start Over (Rescan All)
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="button-row">
                <button className="button" type="submit" disabled={isUploading || !canSaveSession}>
                  {isUploading ? "Saving..." : "Save Label Session"}
                </button>
              </div>
            </form>

            {uploadError ? <p className="error">{uploadError}</p> : null}
            {failedOcrPreview ? (
              <div className="notice" style={{ marginTop: 12 }}>
                <strong>OCR preview</strong>
                <div className="ocr-preview mono">{failedOcrPreview}</div>
              </div>
            ) : null}
            {cameraError ? <p className="error">{cameraError}</p> : null}
            <p className="muted">{status}</p>

            <div className="notice">
              Google Drive storage mode is routed through a storage adapter.
              Until credentials are configured, uploads are stored in stub mode
              and still exercise the verification flow.
            </div>

            <hr className="mobile-divider" />
          </section>

          <section className="card">
            <div className="mobile-step">Step 2 · Part Scan</div>
            <h2>2. Verify Parts (First 3 + Last 3)</h2>
            <p className="muted">
              Scanner gun and camera scans verify automatically. Manual typing can
              still verify on <span className="mono">Enter</span>.
            </p>

            {session ? (
              <div className="code-list" style={{ marginBottom: 16 }}>
                {slotStatuses.map((slot) => (
                  <div className="code-pill split" key={`${slot.box}-${slot.serialIndex}`}>
                    <span>
                      {slot.box === "first" ? "First" : "Last"} Box · Serial {slot.serialIndex}
                    </span>
                    <small className={slot.match ? "result match" : ""}>
                      {slot.match ? `MATCH · ${slot.match.scannedQrValue}` : "PENDING"}
                    </small>
                  </div>
                ))}
              </div>
            ) : null}

            <form onSubmit={handleVerify}>
              <div className="button-row" style={{ marginBottom: 16 }}>
                <button
                  className="button ghost"
                  type="button"
                  onClick={handleStartPartCamera}
                  disabled={!session || Boolean(reportOutcome)}
                >
                  Open Part QR Camera
                </button>
                {isCameraOpen && cameraMode === "part" ? (
                  <button className="button secondary" type="button" onClick={stopCamera}>
                    Close Part Camera
                  </button>
                ) : null}
              </div>

              {isCameraOpen && cameraMode === "part" ? (
                <div className="card" style={{ marginBottom: 16, padding: 16 }}>
                  <div
                    style={{
                      position: "relative",
                      width: "100%",
                      aspectRatio: "16 / 9",
                      minHeight: 240,
                      maxHeight: 360,
                      borderRadius: 18,
                      overflow: "hidden",
                      background: "#000",
                    }}
                  >
                    <video
                      ref={partVideoRef}
                      autoPlay
                      playsInline
                      muted
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                      }}
                    />
                    <div
                      style={{
                        position: "absolute",
                        left: "50%",
                        top: "50%",
                        transform: "translate(-50%, -50%)",
                        width: "55%",
                        aspectRatio: "1 / 1",
                        maxWidth: "70%",
                        border: "3px dashed #4ade80",
                        borderRadius: 12,
                        boxSizing: "border-box",
                        pointerEvents: "none",
                      }}
                    />
                    <div
                      style={{
                        position: "absolute",
                        left: 8,
                        right: 8,
                        bottom: 8,
                        color: "#fff",
                        background: "rgba(0, 0, 0, 0.6)",
                        padding: "6px 10px",
                        borderRadius: 8,
                        fontSize: 12,
                        lineHeight: 1.3,
                        textAlign: "center",
                        pointerEvents: "none",
                      }}
                    >
                      Center the 2D code inside the box
                    </div>
                  </div>
                  <p className="muted" style={{ marginBottom: 0 }}>
                    Small-code tip: fill as much of the frame as possible with the QR,
                    avoid glare, and keep the phone very steady.
                  </p>
                </div>
              ) : null}

              <div className="field">
                <label htmlFor="scannedQrValue">Part QR value</label>
                <input
                  id="scannedQrValue"
                  name="scannedQrValue"
                  type="text"
                  placeholder="Scan or type QR value"
                  required
                  disabled={!session || Boolean(reportOutcome)}
                  value={partScanValue}
                  onChange={(event) => {
                    const nextValue = event.target.value.toUpperCase();
                    setPartScanValue(nextValue);
                    queueAutoSubmit(nextValue);
                  }}
                />
              </div>

              <div className="field">
                <label htmlFor="remarks">Remarks (optional, included in the report)</label>
                <input
                  id="remarks"
                  type="text"
                  placeholder="-"
                  disabled={!session}
                  value={remarksInput}
                  onChange={(event) => setRemarksInput(event.target.value)}
                />
              </div>
            </form>

            {verifyError ? <p className="error">{verifyError}</p> : null}

            {reportOutcome ? (
              <div className={`notice ${reportOutcome === "pass" ? "" : "notice-fail"}`}>
                <strong>{reportOutcome === "pass" ? "PASS" : "FAIL"}</strong> — session closed.{" "}
                {reportSent
                  ? "Report emailed."
                  : `Report not sent${reportError ? `: ${reportError}` : "."}`}
                {!reportSent ? (
                  <div className="button-row" style={{ marginTop: 8 }}>
                    <button
                      className="button secondary"
                      type="button"
                      onClick={handleRetrySendReport}
                      disabled={isFinalizing}
                    >
                      {isFinalizing ? "Sending..." : "Retry Sending Report"}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : session ? (
              <div className="button-row" style={{ marginBottom: 16 }}>
                <button
                  className="button secondary"
                  type="button"
                  onClick={handleFailSession}
                  disabled={isFinalizing}
                >
                  {isFinalizing ? "Sending..." : "Report Mismatch (Fail Session)"}
                </button>
              </div>
            ) : null}

            {lastResult ? (
              <div
                className={`result-hero ${lastResult.result === "matched" ? "match" : "unmatch"}`}
              >
                <div className="kicker">Verification Result</div>
                <div className="word">
                  {lastResult.result === "matched" ? "MATCH" : "UNMATCH"}
                </div>
                <div className="detail">
                  {lastResult.result === "matched"
                    ? `Matched ${lastResult.matchedBoxLabel === "first" ? "First" : "Last"} Box Serial ${lastResult.matchedSerialIndex}.`
                    : "This part does not belong to the current label."}
                </div>
                <div className="qr mono">{lastResult.scannedQrValue}</div>
              </div>
            ) : (
              <div className="result-hero neutral">
                <div className="kicker">Verification Result</div>
                <div className="word">READY</div>
                <div className="detail">
                  Scan the first part QR to show the large result banner here.
                </div>
              </div>
            )}
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <div className="mobile-step">Reference</div>
            <button
              className="section-toggle"
              type="button"
              onClick={() => setShowCodes((value) => !value)}
            >
              <span>
                <strong>Label Session Details</strong>
                <small>
                  {session
                    ? `Session ${session.sessionIdCode} · Part ${session.partNumber}`
                    : "No active label session yet"}
                </small>
              </span>
              <span>{showCodes ? "Hide" : "Show"}</span>
            </button>

            {showCodes && session ? (
              <div className="section-body">
                <p className="muted">
                  Internal key: <span className="mono">{session.sessionKey}</span>
                </p>
                <p className="muted">First Box codes</p>
                <div className="code-list">
                  {session.firstBoxCodes.map((code) => (
                    <div className="code-pill split" key={code}>
                      <span className="mono">{code}</span>
                      <small>valid code</small>
                    </div>
                  ))}
                </div>
                <p className="muted">Last Box codes</p>
                <div className="code-list">
                  {session.lastBoxCodes.map((code) => (
                    <div className="code-pill split" key={code}>
                      <span className="mono">{code}</span>
                      <small>valid code</small>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          <section className="card">
            <div className="mobile-step">History</div>
            <button
              className="section-toggle"
              type="button"
              onClick={() => setShowHistory((value) => !value)}
            >
              <span>
                <strong>Current Session History</strong>
                <small>
                  {history.length
                    ? `${history.length} verification${history.length === 1 ? "" : "s"} saved`
                    : "No parts verified yet"}
                </small>
              </span>
              <span>{showHistory ? "Hide" : "Show"}</span>
            </button>

            {showHistory ? (
              <div className="section-body">
                <p className="muted">
                  Every part check is saved separately so QA history stays traceable.
                </p>

                <div className="history-list">
                  {history.length ? (
                    history.map((item) => (
                      <div className="history-item" key={item.id}>
                        <div className="split">
                          <strong className="mono">{item.scannedQrValue}</strong>
                          <span
                            className={`result ${item.result === "matched" ? "match" : "unmatch"}`}
                          >
                            {item.result === "matched" ? "MATCH" : "UNMATCH"}
                          </span>
                        </div>
                        <small>
                          {new Date(item.verifiedAt).toLocaleString()}
                          {item.matchedBoxLabel
                            ? ` · ${item.matchedBoxLabel === "first" ? "First" : "Last"} Box Serial ${item.matchedSerialIndex}`
                            : ""}
                        </small>
                      </div>
                    ))
                  ) : (
                    <p className="muted">No parts verified yet in this label session.</p>
                  )}
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </main>
  );
}
