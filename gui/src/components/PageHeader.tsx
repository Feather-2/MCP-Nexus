import React from 'react';

export type PageHeaderProps = {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  icon?: React.ReactNode;
};

const PageHeader: React.FC<PageHeaderProps> = ({ title, description, actions, icon }) => {
  return (
    <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3">
          {icon && <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted/50">{icon}</div>}
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
            {description && (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
        </div>
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
};

export default PageHeader;


