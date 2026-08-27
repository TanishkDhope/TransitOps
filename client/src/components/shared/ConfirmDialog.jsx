import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export default function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'destructive',
}) {
  const [isWorking, setIsWorking] = useState(false);

  // Awaits the handler so the dialog cannot be dismissed (or double-fired)
  // while the request is still in flight.
  const handleConfirm = async () => {
    setIsWorking(true);
    try {
      await onConfirm?.();
      onOpenChange(false);
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !isWorking && onOpenChange(next)}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{title || 'Are you sure?'}</DialogTitle>
          <DialogDescription>{description || 'This action cannot be undone.'}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" disabled={isWorking} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant}
            disabled={isWorking}
            onClick={handleConfirm}
            className={
              variant === 'destructive'
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-[#714B67] hover:bg-[#5A3C52]'
            }
          >
            {isWorking ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
