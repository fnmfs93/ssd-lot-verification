"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import jsQR from "jsqr";
import type { AuthUser } from "@/lib/auth/session";

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
  verifiedAt: string;
};

type SessionState = {
  sessionKey: string;
  codes: string[];
  imageRef: string;
  storageMode: string;
  ocrPreview: string;
};

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

  const [session, setSession] = useState<SessionState | null>(null);
  const [history, setHistory] = useState<VerificationRecord[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("Ready for a new label session.");
  const [isUploading, setIsUploading] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [cameraMode, setCameraMode] = useState<"label" | "part" | null>(null);
  const [lastResult, setLastResult] = useState<VerificationRecord | null>(null);
  const [capturedLabelFile, setCapturedLabelFile] = useState<File | null>(null);
  const [capturedPreviewUrl, setCapturedPreviewUrl] = useState<string | null>(null);
  const [partScanValue, setPartScanValue] = useState("");
  const [showCodes, setShowCodes] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [manualCodesInput, setManualCodesInput] = useState("");
  const [failedOcrPreview, setFailedOcrPreview] = useState("");

  const uniqueCodeCount = useMemo(() => session?.codes.length ?? 0, [session]);
  const manualCodeCount = useMemo(
    () => parseManualCodes(manualCodesInput).length,
    [manualCodesInput],
  );

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

      if (submitTimeoutRef.current) {
        window.clearTimeout(submitTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (capturedPreviewUrl) {
        URL.revokeObjectURL(capturedPreviewUrl);
      }
    };
  }, [capturedPreviewUrl]);

  function stopCamera() {
    if (scanLoopRef.current) {
      window.cancelAnimationFrame(scanLoopRef.current);
      scanLoopRef.current = null;
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

  async function createLandscapeCapture(video: HTMLVideoElement) {
    const sourceWidth = video.videoWidth || 1920;
    const sourceHeight = video.videoHeight || 1080;
    const shouldRotate = sourceHeight > sourceWidth;
    const canvas = document.createElement("canvas");

    if (shouldRotate) {
      canvas.width = sourceHeight;
      canvas.height = sourceWidth;
    } else {
      canvas.width = sourceWidth;
      canvas.height = sourceHeight;
    }

    const context = canvas.getContext("2d");

    if (!context) {
      return null;
    }

    if (shouldRotate) {
      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate(-Math.PI / 2);
      context.drawImage(video, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
    } else {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
    }

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

  async function handleStartLabelCamera() {
    setCameraError(null);

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
      setStatus(
        "Camera ready. Keep the phone upright, place the full label inside the wide guide box, then capture.",
      );
    } catch {
      setCameraError(
        "Camera access failed. Check browser permissions or use file upload instead.",
      );
    }
  }

  async function handleCaptureLabel() {
    if (!labelVideoRef.current) {
      setCameraError("Camera preview is not ready yet.");
      return;
    }

    const video = labelVideoRef.current;
    const baseCanvas = await createLandscapeCapture(video);

    if (!baseCanvas) {
      setCameraError("Unable to capture the label image.");
      return;
    }

    const canvas = await cropCanvasToContent(baseCanvas);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.92);
    });

    if (!blob) {
      setCameraError("Unable to save the captured frame.");
      return;
    }

    const file = new File([blob], `label-${Date.now()}.jpg`, {
      type: "image/jpeg",
    });

    setCapturedLabelFile(file);
    setCapturedPreviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }

      return URL.createObjectURL(file);
    });
    stopCamera();
    setStatus("Label captured in landscape. Submit it to extract the codes.");
  }

  async function handleStartPartCamera() {
    if (!session) {
      setVerifyError("Process a label first before scanning part QR codes.");
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
      setVerifyError("Upload a label first.");
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
      }),
    });

    const data = (await response.json().catch(() => null)) as
      | {
          error?: string;
          id?: string;
          scannedQrValue?: string;
          result?: "matched" | "unmatched";
          matchedLabelCode?: string | null;
          verifiedAt?: string;
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
      verifiedAt: data.verifiedAt,
    };

    setLastResult(record);
    setHistory((current) => [record, ...current]);
    setStatus(
      record.result === "matched"
        ? "Part belongs to this label."
        : "Part does not belong to this label.",
    );

    setPartScanValue("");
    lastSubmittedValueRef.current = "";
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
    setIsUploading(true);
    setStatus("Extracting codes from label...");

    const form = event.currentTarget;
    const formData = new FormData(form);
    const uploadedFile = formData.get("file");
    const selectedFile =
      uploadedFile instanceof File && uploadedFile.size > 0
        ? uploadedFile
        : capturedLabelFile;

    if (!selectedFile) {
      setIsUploading(false);
      setUploadError("Choose a label image or capture one with the camera.");
      setStatus("Waiting for a label image.");
      return;
    }

    formData.set("file", selectedFile);
    formData.set(
      "sourceType",
      capturedLabelFile && selectedFile === capturedLabelFile ? "camera" : "upload",
    );
    formData.set("manualCodes", manualCodesInput);

    const response = await fetch("/api/label-session", {
      method: "POST",
      body: formData,
    });

    const data = (await response.json().catch(() => null)) as
      | {
          error?: string;
          sessionKey?: string;
          codes?: string[];
          imageRef?: string;
          storageMode?: string;
          ocrPreview?: string;
        }
      | null;

    setIsUploading(false);

    if (!response.ok || !data?.sessionKey || !data.codes) {
      setUploadError(data?.error ?? "Label processing failed.");
      setFailedOcrPreview(data?.ocrPreview ?? "");
      setStatus("Waiting for a clearer label upload.");
      return;
    }

    setSession({
      sessionKey: data.sessionKey,
      codes: data.codes,
      imageRef: data.imageRef ?? "",
      storageMode: data.storageMode ?? "unknown",
      ocrPreview: data.ocrPreview ?? "",
    });
    setShowCodes(false);
    setShowHistory(false);
    setCapturedLabelFile(null);
    setManualCodesInput("");
    setFailedOcrPreview("");
    setCapturedPreviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }

      return null;
    });
    form.reset();
    setStatus("Label ready. Start scanning part QR values.");
  }

  async function handleVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (submitTimeoutRef.current) {
      window.clearTimeout(submitTimeoutRef.current);
      submitTimeoutRef.current = null;
    }

    await submitPartVerification(partScanValue);
  }

  return (
    <main className="shell">
      <section className="hero">
        <div className="hero-top">
          <div>
            <div className="eyebrow">QA Workspace</div>
            <h1>Verify Many Parts Against One Label</h1>
            <p>
              Signed in as <strong>{user.name}</strong>. Upload one label or capture
              it live, review the extracted 11-character codes, and then scan as
              many parts as needed against that same label session.
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
                <h2>1. Start Label Session</h2>
                <p className="muted">
                  You can upload an image file or use the device camera to take
                  the label photo directly on the QA page.
                </p>
              </div>
            </div>

            <form onSubmit={handleLabelSubmit}>
              <div className="field">
                <label htmlFor="station">Station (optional)</label>
                <input id="station" name="station" type="text" placeholder="QA-01" />
              </div>

              <div className="button-row" style={{ marginBottom: 16 }}>
                <button className="button ghost" type="button" onClick={handleStartLabelCamera}>
                  Open Camera
                </button>
                {isCameraOpen && cameraMode === "label" ? (
                  <button className="button secondary" type="button" onClick={stopCamera}>
                    Close Camera
                  </button>
                ) : null}
              </div>

              {isCameraOpen && cameraMode === "label" ? (
                <div className="card" style={{ marginBottom: 16, padding: 16 }}>
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
                        left: "50%",
                        top: "50%",
                        width: "88%",
                        height: "40%",
                        transform: "translate(-50%, -50%)",
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
                      Keep phone upright. Fit the full label inside the dashed box.
                    </div>
                  </div>
                  <div className="button-row" style={{ marginTop: 14 }}>
                    <button className="button" type="button" onClick={handleCaptureLabel}>
                      Capture Label
                    </button>
                  </div>
                </div>
              ) : null}

              {capturedPreviewUrl ? (
                <div style={{ marginBottom: 16 }}>
                  <p className="muted">Captured label preview</p>
                  <img
                    src={capturedPreviewUrl}
                    alt="Captured label"
                    style={{
                      width: "100%",
                      borderRadius: 18,
                      border: "1px solid var(--line)",
                    }}
                  />
                </div>
              ) : null}

              <div className="field">
                <label htmlFor="file">Label image upload</label>
                <input id="file" name="file" type="file" accept="image/*" />
              </div>

              <div className="field">
                <label htmlFor="manualCodes">
                  Manual label codes fallback (optional)
                </label>
                <textarea
                  id="manualCodes"
                  name="manualCodes"
                  rows={4}
                  placeholder="Paste 11-character codes here if OCR misses them, for example:&#10;J16262915HQ&#10;J16262915HZ&#10;J16262915HW"
                  value={manualCodesInput}
                  onChange={(event) => setManualCodesInput(event.target.value.toUpperCase())}
                />
                <small className="muted">
                  {manualCodeCount
                    ? `${manualCodeCount} manual code${manualCodeCount === 1 ? "" : "s"} ready as fallback`
                    : "Leave blank to use OCR only."}
                </small>
              </div>

              <div className="button-row">
                <button className="button" type="submit" disabled={isUploading}>
                  {isUploading ? "Processing label..." : "Process Label"}
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
            <h2>2. Verify Part QR</h2>
            <p className="muted">
              Scanner gun and camera scans verify automatically. Manual typing can
              still verify on <span className="mono">Enter</span>.
            </p>

            <form onSubmit={handleVerify}>
              <div className="button-row" style={{ marginBottom: 16 }}>
                <button
                  className="button ghost"
                  type="button"
                  onClick={handleStartPartCamera}
                  disabled={!session}
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
                  disabled={!session}
                  value={partScanValue}
                  onChange={(event) => {
                    const nextValue = event.target.value.toUpperCase();
                    setPartScanValue(nextValue);
                    queueAutoSubmit(nextValue);
                  }}
                />
              </div>
            </form>

            {verifyError ? <p className="error">{verifyError}</p> : null}

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
                    ? "This part belongs to the current label."
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
                <strong>Extracted Label Codes</strong>
                <small>
                  {session
                    ? `${uniqueCodeCount} code${uniqueCodeCount === 1 ? "" : "s"} extracted from this label`
                    : "No active label session yet"}
                </small>
              </span>
              <span>{showCodes ? "Hide" : "Show"}</span>
            </button>

            {showCodes && session ? (
              <div className="section-body">
                <p className="muted">
                  Session: <span className="mono">{session.sessionKey}</span>
                </p>
                <div className="code-list">
                  {session.codes.map((code) => (
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
                          {item.matchedLabelCode ? ` · matched ${item.matchedLabelCode}` : ""}
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
