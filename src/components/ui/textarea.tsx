import * as React from 'react';
import { cn } from '@/lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(
    'min-h-16 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50 max-md:text-base',
    className)} {...props} />;
}

export { Textarea };
