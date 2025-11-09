import React from 'react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';

type RightPanelProps = {
  open: boolean;
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
  widthClassName?: string; // e.g. max-w-md, w-96
};

const RightPanel: React.FC<RightPanelProps> = ({ open, title, onClose, children, widthClassName }) => {
  const { t } = useI18n()
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className={`absolute right-0 top-0 h-full w-full sm:w-[420px] ${widthClassName || ''} bg-card border-l shadow-xl flex flex-col`}>
        <div className="flex items-center justify-between pl-4 pr-2 h-14 border-b">
          <div className="font-medium">{title || t('common.settings')}</div>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {children}
        </div>
      </div>
    </div>
  );
};

export default RightPanel;



