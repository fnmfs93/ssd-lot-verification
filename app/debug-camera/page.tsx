// Deliberately zero React state/hooks and no client bundle dependency —
// this is a plain server-rendered page with a literal inline <script> tag,
// so it tests the browser's raw JS + camera API support directly, with no
// dependency on the main app's React/Next.js client bundle hydrating
// correctly. Used to isolate whether a problem seen only on one specific
// device's browser is (a) that browser failing to run the app's compiled
// JS bundle at all, or (b) something narrower like getUserMedia being
// blocked/unsupported specifically.
export default function DebugCameraPage() {
  return (
    <div style={{ padding: 20, fontFamily: "sans-serif", fontSize: 16 }}>
      <h1>Camera / JS Diagnostic</h1>
      <p id="js-status">JS has not run yet.</p>
      <button id="test-btn" style={{ fontSize: 20, padding: "16px 24px" }}>
        1. Tap: Test JS
      </button>
      <button
        id="cam-btn"
        style={{ fontSize: 20, padding: "16px 24px", marginLeft: 8, marginTop: 8 }}
      >
        2. Tap: Test Camera
      </button>
      <pre
        id="log"
        style={{
          whiteSpace: "pre-wrap",
          background: "#eee",
          padding: 12,
          marginTop: 16,
          minHeight: 100,
        }}
      />
      <script
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: `
            document.getElementById('js-status').textContent = 'JS is running. UA: ' + navigator.userAgent;
            function log(msg) {
              var el = document.getElementById('log');
              el.textContent += msg + '\\n';
            }
            document.getElementById('test-btn').addEventListener('click', function () {
              log('Button click fired at ' + new Date().toISOString());
            });
            document.getElementById('cam-btn').addEventListener('click', function () {
              log('Camera button tapped. navigator.mediaDevices exists: ' + (!!navigator.mediaDevices));
              if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                log('getUserMedia is NOT available on this browser at all.');
                return;
              }
              navigator.mediaDevices.getUserMedia({ video: true, audio: false })
                .then(function (stream) {
                  log('SUCCESS: got camera stream with ' + stream.getVideoTracks().length + ' video track(s).');
                  stream.getTracks().forEach(function (t) { t.stop(); });
                })
                .catch(function (err) {
                  log('FAILED: ' + (err && err.name) + ': ' + (err && err.message));
                });
            });
          `,
        }}
      />
    </div>
  );
}
