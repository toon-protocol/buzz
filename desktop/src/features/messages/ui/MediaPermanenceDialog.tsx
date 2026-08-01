import * as React from "react";

import {
  acceptMediaPermanence,
  declineMediaPermanence,
  getMediaPermanenceDisclosure,
  subscribeMediaPermanence,
} from "@/shared/api/mediaPermanenceGate";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";

/**
 * The one-time permanence disclosure, shown before a user's first upload to
 * the TOON store node.
 *
 * Mounted once at the app root and driven by the module-level gate, because
 * the acknowledgement belongs to the user rather than to whichever composer
 * happens to be focused (see `mediaPermanenceGate.ts`).
 *
 * All the wording comes from `permanenceDisclosureCopy` rather than living in
 * JSX, so a test can assert what this dialog promises — in particular that it
 * never promises a deletion. This component is only the shape.
 *
 * Escape and the overlay both count as declining: an upload nobody consented
 * to must not proceed, and permanence is exactly the case where "they probably
 * meant yes" is the wrong default.
 */
export function MediaPermanenceDialog() {
  const copy = React.useSyncExternalStore(
    subscribeMediaPermanence,
    getMediaPermanenceDisclosure,
    () => null,
  );

  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) declineMediaPermanence();
      }}
      open={copy !== null}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy?.title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-left">
              {copy?.body.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              <p className="font-medium text-foreground">{copy?.feeLine}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button
              onClick={() => declineMediaPermanence()}
              type="button"
              variant="outline"
            >
              {copy?.cancelLabel}
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button onClick={() => acceptMediaPermanence()} type="button">
              {copy?.confirmLabel}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
