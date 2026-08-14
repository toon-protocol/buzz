/**
 * Progressive getUserMedia fallback for huddle mic capture (buzz#200).
 *
 * WebKitGTK rejects a constraint set outright with a bare "Invalid
 * constraint" DOMException — no NotFoundError/OverconstrainedError name —
 * when it has audio hardware but no device it considers a real microphone
 * (it excludes monitor-class PulseAudio sources). That is a real desktop
 * Linux state, not just a container quirk. The spec says an unsupported
 * *ideal* constraint (like our sampleRate hint) should be ignored, but
 * WebKitGTK fails the whole request instead, so degrade progressively
 * before concluding there is no usable capture device.
 */

export const NO_MICROPHONE_MESSAGE =
  "No microphone found. You can still listen, but others won’t hear you.";

const NO_DEVICE_ERROR_NAMES = new Set([
  "NotFoundError",
  "DevicesNotFoundError",
  "OverconstrainedError",
  "ConstraintNotSatisfiedError",
]);

function errorName(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return null;
  }
  const { name } = error as { name: unknown };
  return typeof name === "string" ? name : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Recognizes the "no usable capture device" class of getUserMedia
 * rejection — standard no-device DOMException names, plus WebKitGTK's
 * unnamed "Invalid constraint" rejection — as distinct from e.g. a denied
 * mic permission, which should still fail the join. */
export function isNoMicrophoneCaptureError(error: unknown): boolean {
  const name = errorName(error);
  if (name && NO_DEVICE_ERROR_NAMES.has(name)) return true;
  return /invalid constraint/i.test(errorMessage(error));
}

type GetUserMediaAudio = (constraints: {
  audio: MediaTrackConstraints | boolean;
}) => Promise<MediaStream>;

/**
 * Tries `preferred`, then the same constraints without `sampleRate` (the
 * ideal-valued hint WebKitGTK rejects outright instead of ignoring), then
 * the bare device with no constraints at all. Resolves `null` if every
 * attempt fails with a no-mic-class error (see `isNoMicrophoneCaptureError`)
 * — callers should treat that as a listener-only join, not a hard failure.
 * Any other error (e.g. a denied mic permission) is rethrown.
 */
export async function captureMicWithFallback(
  preferred: MediaTrackConstraints,
  selectedDeviceId: string,
  getUserMedia: GetUserMediaAudio,
): Promise<MediaStream | null> {
  const { sampleRate: _sampleRate, ...withoutSampleRate } = preferred;
  const bare: MediaTrackConstraints | boolean = selectedDeviceId
    ? { deviceId: { exact: selectedDeviceId } }
    : true;

  const attempts: (MediaTrackConstraints | boolean)[] = [
    preferred,
    withoutSampleRate,
    bare,
  ];

  let lastError: unknown = null;
  for (const [index, audio] of attempts.entries()) {
    try {
      return await getUserMedia({ audio });
    } catch (err) {
      lastError = err;
      console.warn(
        `[huddle] getUserMedia attempt ${index + 1}/${attempts.length} failed:`,
        err,
      );
    }
  }

  if (isNoMicrophoneCaptureError(lastError)) return null;
  throw lastError;
}
