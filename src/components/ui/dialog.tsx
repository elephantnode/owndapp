import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay data-slot="dialog-overlay" className="fixed inset-0 z-20 bg-[oklch(22%_.015_160/.25)]" />
    <DialogPrimitive.Content data-slot="dialog-content" className={cn(
      'fixed top-1/2 left-1/2 z-20 max-h-[calc(100dvh-48px)] w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border bg-popover p-6 text-popover-foreground shadow-dialog',
      className)} {...props}>
      {children}
      <DialogPrimitive.Close data-slot="dialog-close" aria-label="閉じる" className="absolute top-5 right-5 grid size-9 cursor-pointer place-content-center rounded-md text-muted-foreground transition-[background-color] duration-120 ease-out hover:bg-accent">
        <X className="size-[19px]" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>;
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('mb-6 pr-10', className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-footer" className={cn('flex items-center justify-end gap-3 pt-2', className)} {...props} />;
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn('text-base leading-snug font-semibold', className)} {...props} />;
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn('mt-1 text-xs text-muted-foreground', className)} {...props} />;
}

export { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription };
