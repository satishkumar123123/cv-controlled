# Assignment compliance and evidence

This review uses the complete assignment and the supplied
[squat reference image](assets/squat-depth-reference.jpg). Its four hip/knee bands match the implementation
exactly. Software checks and human measurement validation are reported separately.

| Requirement | Implementation / evidence | Validation status |
| --- | --- | --- |
| Playable Phaser runner with jump/duck obstacles | `GameScene.js`; real Arcade collision and five-minute simulation checks | Automated |
| Evaluator quick-start / webcam-free fallback | Explicit clone destination, Node/shell prerequisites, opt-in Space/Down/R mode; capture stopped and pose metrics cleared | Unit and browser regression checks; camera remains the default |
| One webcam and documented model | MediaPipe Pose GHUM Lite; 640×480 requested; local WASM/model assets | Runtime integration checked with a generated camera |
| One jump per movement / held duck | Debounce, neutral rearm, continuous `desiredDuckState`, ground-collider reconciliation | FSM/regression/browser fixtures |
| Neutral, sway, head motion, landing and duck-rise rejection | Bilateral feet plus hip velocity; 250 ms minimum cooldown plus neutral recovery | Deterministic fixtures; human rates pending |
| Duck means crouch, not foot rotation | Grounded hip drop plus knee flexion; explicit foot-rotation rejection test | Automated |
| Missing/low-confidence landmarks | Raw 0.65 gate before EMA; pause/cancel; `null`/— metrics | Every required lower-body landmark tested |
| Calibration and different body sizes/distances | 3 s upright hold; torso-normalized thresholds; individual heel/toe baselines and noise/self-check | Calibration fixtures; different-user trials pending |
| Flight time / ballistic height | Heel/toe departure/contact timestamps; `9.81 × t² / 8`; documented symmetry assumptions | Known-time geometry/FSM fixtures |
| Hip vertical displacement | Peak rise above baseline in normalized image height | Deterministic fixtures |
| Knee / hip / ankle angles during jump | Bilateral knee, unsigned 3D hip, signed sagittal hip proxy and signed shin/foot ankle proxy | Deterministic angle/sign/rotation/confidence tests |
| Preparation, takeoff, flight and landing tracking | `ActionRecorder.js`; retrospective contact timestamps, per-phase ranges and bounded numeric samples | Real-classifier sequence tests |
| Duck angles, depth, lean, stance and bottom pause | Live bilateral metrics; strict angular bands; separate knee-level metadata | Kinematics/FSM/DOM tests |
| Clear unreliable indicators | — per unavailable metric; historical ranges explicitly labeled; interrupted actions discarded | Unit/DOM checks |
| Inference latency, action latency and camera FPS | Live HUD; duration/averages/hardware/model/camera summary; session JSON export | Timing fixtures and recorded software-WebGL sample |
| Empirical target-laptop performance | Protocol in README; hardware notes and downloadable session report | **Pending a physical-device run** |
| Modular source and technical defense | Vision, classifier, analytics, UI, Phaser and desktop modules | Source review and README |
| Working desktop delivery | Electron entry point, local model assets, isolated renderer and platform packaging commands | Source and packaged Linux smoke checks passed; Windows/macOS require native evaluation |
| Automated logic/analytics tests | 214/214 Vitest tests across 8 suites (206 original + 8 keyboard regressions); actual Phaser, production-model and Electron checks | Reproducible commands and CI linked from README |
| Manual evaluation at different speeds/users | Reproduction matrix and blank observation CSV below | **Pending human observation; no invented outcomes** |
| Short demo video (optional) | Prominent README placeholder and recording checklist in manual protocol | **Pending physical-webcam recording; placeholder is not a recording** |

The implementation is ready for physical evaluation. A passing synthetic test
suite cannot establish real-person accuracy or turn target performance values
into measured results. Record those observations before claiming complete
empirical validation.

## Manual detection and metrics protocol

1. Use at least two consenting participants with different body proportions;
   identify them using codes such as P01/P02. Record camera, lighting, distance,
   OS/browser, CPU/GPU/RAM and exact commit. Each participant recalibrates.
2. Begin at 2.0 m, then repeat at 2.5 m if the whole body remains visible. Use
   fixed camera height/orientation. Confirm neutral arming after the 3 s hold.
3. For each participant, perform five comfortable jumps and five held crouches
   at slow, ordinary and brisk transitions. Do not force a depth or speed that
   the participant cannot comfortably perform. Observe physical movement and
   classifier transitions; count game commands separately from rejected inputs.
4. Add 30 s neutral standing, ordinary sway/head movement, outward foot rotation,
   crouch-to-stand, prolonged landing knee bends, a brief foot twitch, one-foot
   occlusion and a camera stop/retry. Neutral/sway/foot rotation should emit no
   jump/duck; occlusion should pause and clear live metrics.
5. Use `docs/manual-validation.csv`: expected physical movements, correct detections,
   missed movements, false events and repeated events are separate counts. Record
   held-duck release timing and whether physical squatting occurred during a
   virtual landing. Preserve failures as well as successful trials.
6. Warm up for 10 s, **Reset sample**, then run a 60 s performance trial with at
   least ten jumps and ten duck/stand cycles. Enter machine/session notes and
   **Export session JSON**. Repeat three trials. Report actual averages, accepted
   action counts, active duration and capture timestamp source. No accepted
   actions means no action-latency result. Record rendering/CPU/heap separately.
7. To validate angles, compare synchronized, clearly visible sagittal-view frames
   against a goniometric/reference method; annotate uncertainty. For flight time,
   use synchronized contact/video evidence; a force plate is preferable if
   available. Report MAE only from genuine paired reference measurements.
8. A 60–90 s demo should show the desktop window, camera view, calibration, one
   jump, a held crouch, landing recovery, occlusion fallback, collision/restart
   and the metrics/export. Identify simulated inputs if any are shown. Obtain
   permission before sharing an identifiable camera recording.

The app stores only bounded numeric action samples in memory. The last five
completed actions and at most 600 samples per action are exported. A truncated
record explicitly says that its ranges cover retained samples. Export between
trial blocks; long trials should also use the observation CSV.
