import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border font-medium', {
  variants: {
    variant: {
      secondary: 'border-transparent bg-secondary px-1.5 py-px text-micro font-normal text-secondary-foreground',
      outline: 'border-border px-1.5 text-micro text-muted-foreground',
    },
  },
  defaultVariants: { variant: 'secondary' },
});

function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
