import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const alertVariants = cva('flex w-full items-start gap-3 rounded-md px-4 py-3 text-[13px] [overflow-wrap:anywhere] [&>svg]:mt-0.5 [&>svg]:shrink-0', {
  variants: {
    variant: {
      default: 'border bg-card text-card-foreground',
      destructive: 'bg-error-subtle text-error',
      success: 'bg-success-subtle text-success',
      warning: 'bg-warning-subtle text-warning',
    },
  },
  defaultVariants: { variant: 'default' },
});

// role defaults to alert; pass role="status" for non-urgent confirmations.
function Alert({ className, variant, ...props }: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-description" className={cn('flex-1', className)} {...props} />;
}

export { Alert, AlertDescription };
