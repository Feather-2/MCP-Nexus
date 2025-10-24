import React from 'react';
import { Input } from './ui/input';

type TableToolbarProps = {
  placeholder?: string;
  onSearchChange?: (value: string) => void;
  left?: React.ReactNode;
  right?: React.ReactNode;
};

const TableToolbar: React.FC<TableToolbarProps> = ({ placeholder = '搜索…', onSearchChange, left, right }) => {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-3">
      <div className="flex items-center gap-2 min-w-0">
        <div className="relative w-[260px] max-w-full">
          <Input
            placeholder={placeholder}
            className="pl-3 pr-10"
            onChange={(e) => onSearchChange?.(e.target.value)}
          />
        </div>
        {left}
      </div>
      <div className="flex items-center gap-2">
        {right}
      </div>
    </div>
  );
};

export default TableToolbar;


