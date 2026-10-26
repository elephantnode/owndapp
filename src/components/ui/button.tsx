import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border text-sm font-medium no-underline transition-[color,background-color,border-color] duration-120 ease-out hover:no-underline disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: 'border-primary bg-primary text-primary-foreground hover:border-primary-hover hover:bg-primary-hover',
        destructive: 'border-destructive bg-destructive text-primary-foreground hover:opacity-90',
        outline: 'border-border bg-background text-foreground hover:border-border-strong hover:bg-accent',
        secondary: 'border-transparent bg-secondary text-secondary-foreground hover:bg-accent hover:text-foreground',
        ghost: 'border-transparent bg-transparent text-foreground hover:bg-accent',
        link: 'border-transparent bg-transparent text-brand hover:underline',
      },
      size: {
        default: 'min-h-10 px-4 py-2 max-md:min-h-11',
        sm: 'min-h-8 px-3 py-1 text-xs max-md:min-h-11',
        icon: 'size-9 p-1.5 text-muted-foreground max-md:size-11',
      },
    },
    defaultVariants: { variant: 'outline', size: 'default' },
  },
);

function Button({ className, variant, size, asChild = false, ...props }: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
