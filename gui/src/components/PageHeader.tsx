import React from 'react';

export type PageHeaderProps = {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  icon?: React.ReactNode;
};

const PageHeader: React.FC<PageHeaderProps> = ({ title, description, actions, icon }) => {
  return (
    <div className="mb-5 md:mb-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {icon && <div className="shrink-0">{icon}</div>}
            <h1 className="text-[18px] font-semibold leading-6 tracking-[-0.01em] text-foreground truncate">{title}</h1>
          </div>
          {description && (
            <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-2 shrink-0">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
};

export default PageHeader;


