import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

// Native <select> keeps macOS menus, form autofill and keyboard behavior; only the frame is styled.
function NativeSelect({ className, containerClassName, size = 'default', ...props }: Omit<React.ComponentProps<'select'>, 'size'> & { size?: 'sm' | 'default'; containerClassName?: string }) {
  return <div data-slot="native-select-wrapper" className={cn('relative w-fit has-[select:disabled]:opacity-50', containerClassName)}>
    <select data-slot="native-select" data-size={size} className={cn(
      'w-full min-w-0 cursor-pointer appearance-none rounded-md border border-input bg-background py-2 pr-9 pl-3 text-sm disabled:cursor-not-allowed max-md:text-base',
      'min-h-10 data-[size=sm]:min-h-8.5 data-[size=sm]:border-transparent data-[size=sm]:bg-raised data-[size=sm]:py-1.5 data-[size=sm]:pl-2 data-[size=sm]:text-xs',
      className)} {...props} />
    <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
  </div>;
}

function NativeSelectOption(props: React.ComponentProps<'option'>) {
  return <option data-slot="native-select-option" {...props} />;
}

export { NativeSelect, NativeSelectOption };
