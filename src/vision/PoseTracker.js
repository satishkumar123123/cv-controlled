// Placeholder for MediaPipe Camera loop
export class PoseTracker {
  constructor(videoElement, canvasElement) {
    this.video = videoElement;
    this.canvas = canvasElement;
  }

  async init() {
    console.log("Pose tracker ready for MediaPipe binding.");
  }
}
