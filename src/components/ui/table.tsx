import * as React from 'react';
import { cn } from '@/lib/utils';

function Table({ className, containerClassName, ...props }: React.ComponentProps<'table'> & { containerClassName?: string }) {
  return <div data-slot="table-container" className={cn('relative w-full overflow-x-auto', containerClassName)}>
    <table data-slot="table" className={cn('w-full border-collapse text-left text-xs', className)} {...props} />
  </div>;
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={className} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={className} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return <tr data-slot="table-row" className={cn('group/row border-b data-[state=selected]:bg-brand-subtle', className)} {...props} />;
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return <th data-slot="table-head" className={cn('border-y bg-raised px-4 py-3 text-caption font-medium whitespace-nowrap text-muted-foreground', className)} {...props} />;
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td data-slot="table-cell" className={cn('px-4 py-6 align-middle group-hover/row:bg-row-hover', className)} {...props} />;
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
