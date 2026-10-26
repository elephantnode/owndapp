import * as React from 'react';
import { cn } from '@/lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn(
    'min-h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm transition-[border-color] duration-120 ease-out aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50 max-md:text-base',
    className)} {...props} />;
}

export { Input };
