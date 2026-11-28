// clawddesk-presence: is someone at the desk? Watches the camera with Apple's Vision face detector,
// on this Mac only (no frames are stored or sent anywhere), and prints one JSON line per change:
//   {"faces": 1}            a face is visible (also repeated every 10 s while it stays)
//   {"faces": 0}            nobody in view
//   {"error": "..."}        camera unavailable / permission denied
// `--status` prints the camera authorization status without asking for it. Exits when stdin closes.

import AVFoundation
import Foundation
import Vision

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}

func statusName(_ s: AVAuthorizationStatus) -> String {
    switch s {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

if CommandLine.arguments.contains("--status") {
    emit(["camera": statusName(AVCaptureDevice.authorizationStatus(for: .video)),
          "device": AVCaptureDevice.default(for: .video)?.localizedName ?? NSNull()])
    exit(0)
}

final class Watcher: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    let queue = DispatchQueue(label: "presence.frames")
    var lastCheck = Date.distantPast
    var lastFaces = -1
    var lastEmit = Date.distantPast
    /// Analyse about one frame per second: presence doesn't need more, and it keeps the CPU idle.
    let interval: TimeInterval = 1.0

    func start() throws {
        guard let device = AVCaptureDevice.default(for: .video) else { throw NSError(domain: "presence", code: 1, userInfo: [NSLocalizedDescriptionKey: "no camera"]) }
        let input = try AVCaptureDeviceInput(device: device)
        session.beginConfiguration()
        session.sessionPreset = .low
        guard session.canAddInput(input) else { throw NSError(domain: "presence", code: 2, userInfo: [NSLocalizedDescriptionKey: "camera busy"]) }
        session.addInput(input)
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else { throw NSError(domain: "presence", code: 3, userInfo: [NSLocalizedDescriptionKey: "cannot read frames"]) }
        session.addOutput(output)
        session.commitConfiguration()
        session.startRunning()
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let now = Date()
        guard now.timeIntervalSince(lastCheck) >= interval, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastCheck = now
        let request = VNDetectFaceRectanglesRequest()
        do {
            try VNImageRequestHandler(cvPixelBuffer: pixels, options: [:]).perform([request])
        } catch {
            return
        }
        let faces = request.results?.count ?? 0
        if faces != lastFaces || (faces > 0 && now.timeIntervalSince(lastEmit) >= 10) {
            emit(["faces": faces])
            lastFaces = faces
            lastEmit = now
        }
    }
}

let watcher = Watcher()

func run() {
    do {
        try watcher.start()
    } catch {
        emit(["error": error.localizedDescription])
        exit(2)
    }
}

switch AVCaptureDevice.authorizationStatus(for: .video) {
case .authorized:
    run()
case .notDetermined:
    AVCaptureDevice.requestAccess(for: .video) { granted in
        if granted { DispatchQueue.main.async { run() } } else { emit(["error": "camera permission denied"]); exit(3) }
    }
default:
    emit(["error": "camera permission denied (System Settings › Privacy & Security › Camera)"])
    exit(3)
}

// The parent (ClawdDesk) closes our stdin when it stops us or quits: then stop the camera and exit.
DispatchQueue.global().async {
    while readLine() != nil {}
    watcher.session.stopRunning()
    exit(0)
}

RunLoop.main.run()
