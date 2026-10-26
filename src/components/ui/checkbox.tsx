import * as React from 'react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return <CheckboxPrimitive.Root data-slot="checkbox" className={cn(
    'peer group/checkbox grid size-[17px] shrink-0 cursor-pointer place-content-center rounded-sm border border-border-strong bg-background transition-[background-color,border-color] duration-120 ease-out disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground',
    className)} {...props}>
    <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="grid place-content-center">
      <Check className="size-3.5 group-data-[state=indeterminate]/checkbox:hidden" strokeWidth={3} />
      <Minus className="hidden size-3.5 group-data-[state=indeterminate]/checkbox:block" strokeWidth={3} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>;
}

export { Checkbox };
