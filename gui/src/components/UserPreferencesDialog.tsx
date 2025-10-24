import React, { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PreferencesManager, type UserPreferences, DEFAULT_PREFERENCES } from '../utils/persistence';
import { useToastHelpers } from './ui/toast';
import { Settings, Palette, Bell, RotateCcw } from 'lucide-react';

interface UserPreferencesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const UserPreferencesDialog: React.FC<UserPreferencesDialogProps> = ({
  open,
  onOpenChange
}) => {
  const { success } = useToastHelpers();
  const [preferences, setPreferences] = useState<UserPreferences>(() => 
    PreferencesManager.getPreferences()
  );

  const handleSave = () => {
    PreferencesManager.setPreferences(preferences);
    success('偏好设置已保存', '您的个人偏好设置已成功保存');
    onOpenChange(false);
  };

  const handleReset = () => {
    setPreferences(DEFAULT_PREFERENCES);
    PreferencesManager.resetPreferences();
    success('偏好设置已重置', '所有偏好设置已恢复为默认值');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            用户偏好设置
          </DialogTitle>
          <DialogDescription>
            配置您的个人使用偏好，这些设置将保存在浏览器中
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Theme Settings */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Palette className="h-4 w-4 text-blue-500" />
                <CardTitle className="text-base">外观设置</CardTitle>
              </div>
              <CardDescription>配置界面主题和显示偏好</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium">主题模式</label>
                  <Select 
                    value={preferences.theme} 
                    onValueChange={(value: 'light' | 'dark' | 'auto') => 
                      setPreferences(prev => ({ ...prev, theme: value }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="light">明亮模式</SelectItem>
                      <SelectItem value="dark">暗黑模式</SelectItem>
                      <SelectItem value="auto">跟随系统</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-sm font-medium">默认页面大小</label>
                  <Input
                    type="number"
                    value={preferences.defaultPageSize}
                    onChange={(e) => setPreferences(prev => ({ 
                      ...prev, 
                      defaultPageSize: parseInt(e.target.value) || 10 
                    }))}
                    min="5"
                    max="100"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium flex items-center gap-2">
                  侧边栏状态
                  <Badge variant="outline" className="text-xs">
                    {preferences.sidebarCollapsed ? '折叠' : '展开'}
                  </Badge>
                </label>
                <div className="mt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPreferences(prev => ({ 
                      ...prev, 
                      sidebarCollapsed: !prev.sidebarCollapsed 
                    }))}
                  >
                    {preferences.sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Notification Settings */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-green-500" />
                <CardTitle className="text-base">通知设置</CardTitle>
              </div>
              <CardDescription>配置通知显示偏好</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium">通知持续时间 (秒)</label>
                  <Input
                    type="number"
                    value={preferences.notificationSettings.toastDuration / 1000}
                    onChange={(e) => setPreferences(prev => ({ 
                      ...prev, 
                      notificationSettings: {
                        ...prev.notificationSettings,
                        toastDuration: (parseInt(e.target.value) || 5) * 1000
                      }
                    }))}
                    min="1"
                    max="30"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">自动刷新间隔 (秒)</label>
                  <Input
                    type="number"
                    value={preferences.autoRefreshInterval / 1000}
                    onChange={(e) => setPreferences(prev => ({ 
                      ...prev, 
                      autoRefreshInterval: (parseInt(e.target.value) || 15) * 1000 
                    }))}
                    min="5"
                    max="300"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">显示成功通知</label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPreferences(prev => ({
                      ...prev,
                      notificationSettings: {
                        ...prev.notificationSettings,
                        showSuccessToasts: !prev.notificationSettings.showSuccessToasts
                      }
                    }))}
                  >
                    <Badge variant={preferences.notificationSettings.showSuccessToasts ? "default" : "secondary"}>
                      {preferences.notificationSettings.showSuccessToasts ? "已启用" : "已禁用"}
                    </Badge>
                  </Button>
                </div>
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">显示错误通知</label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPreferences(prev => ({
                      ...prev,
                      notificationSettings: {
                        ...prev.notificationSettings,
                        showErrorToasts: !prev.notificationSettings.showErrorToasts
                      }
                    }))}
                  >
                    <Badge variant={preferences.notificationSettings.showErrorToasts ? "default" : "secondary"}>
                      {preferences.notificationSettings.showErrorToasts ? "已启用" : "已禁用"}
                    </Badge>
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="flex justify-between pt-4">
          <Button variant="outline" onClick={handleReset} className="gap-2">
            <RotateCcw className="h-4 w-4" />
            重置为默认值
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button onClick={handleSave}>
              保存设置
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};