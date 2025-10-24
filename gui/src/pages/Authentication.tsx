import React, { useState, useEffect } from 'react';
import { apiClient } from '../api/client';
import { useToastHelpers } from '../components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import PageHeader from '@/components/PageHeader';
import { useI18n } from '@/i18n';
import {
  Shield,
  Key,
  Plus,
  Trash2,
  Eye,
  EyeOff
} from 'lucide-react';

const Authentication: React.FC = () => {
  const { t } = useI18n();
  const { success, error: showError } = useToastHelpers();
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeys, setApiKeys] = useState<any[]>([]);
  const [tokens, setTokens] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateApiKey, setShowCreateApiKey] = useState(false);
  const [showCreateToken, setShowCreateToken] = useState(false);
  const [newApiKey, setNewApiKey] = useState({ name: '', permissions: ['read'] });
  const [newToken, setNewToken] = useState({ userId: '', permissions: ['read'], expiresInHours: 24 });

  // Load data from server
  useEffect(() => {
    const loadData = async () => {
      try {
        setError(null);
        const [apiKeysResult, tokensResult] = await Promise.all([
          apiClient.listApiKeys(),
          apiClient.listTokens()
        ]);

        if (apiKeysResult.ok) {
          setApiKeys(apiKeysResult.data || []);
        } else {
          setError(apiKeysResult.error || t('auth.loadKeysFailed'));
        }

        if (tokensResult.ok) {
          setTokens(tokensResult.data || []);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('auth.loadFailed'));
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, []);

  const handleCreateApiKey = async () => {
    if (!newApiKey.name) {
      showError(t('auth.createFail'), t('auth.enterApiKeyName'));
      return;
    }

    try {
      const result = await apiClient.createApiKey(newApiKey.name, newApiKey.permissions);
      if (result.ok) {
        success(t('auth.apiKeyCreated'), `${result.data?.apiKey || ''}`);
        setShowCreateApiKey(false);
        setNewApiKey({ name: '', permissions: ['read'] });
        const apiKeysResult = await apiClient.listApiKeys();
        if (apiKeysResult.ok) setApiKeys(apiKeysResult.data || []);
      } else {
        showError(t('auth.createFail'), result.error || t('common.unknown'));
      }
    } catch (err) {
      showError(t('auth.createFail'), err instanceof Error ? err.message : t('common.unknown'));
    }
  };

  const handleDeleteApiKey = async (key: string) => {
    if (!confirm(t('auth.confirmDeleteKey'))) return;
    try {
      const result = await apiClient.deleteApiKey(key);
      if (result.ok) {
        success(t('common.deleteSuccess'), t('auth.apiKeyDeleted'));
        const apiKeysResult = await apiClient.listApiKeys();
        if (apiKeysResult.ok) setApiKeys(apiKeysResult.data || []);
      } else {
        showError(t('common.deleteFail'), result.error || t('common.unknown'));
      }
    } catch (err) {
      showError(t('common.deleteFail'), err instanceof Error ? err.message : t('common.unknown'));
    }
  };

  const handleCreateToken = async () => {
    if (!newToken.userId) {
      showError(t('auth.createFail'), t('auth.enterUserId'));
      return;
    }

    try {
      const result = await apiClient.generateToken(
        newToken.userId,
        newToken.permissions,
        newToken.expiresInHours
      );
      if (result.ok) {
        success(t('auth.tokenCreated'), `${result.data?.token || ''}`);
        setShowCreateToken(false);
        setNewToken({ userId: '', permissions: ['read'], expiresInHours: 24 });
        const tokensResult = await apiClient.listTokens();
        if (tokensResult.ok) setTokens(tokensResult.data || []);
      } else {
        showError(t('auth.createFail'), result.error || t('common.unknown'));
      }
    } catch (err) {
      showError(t('auth.createFail'), err instanceof Error ? err.message : t('common.unknown'));
    }
  };

  const maskApiKey = (key: string) => {
    if (showApiKey) return key;
    return key.substring(0, 8) + '...' + key.substring(key.length - 4);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-lg text-muted-foreground">{t('auth.loading')}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('auth.title')} description={t('auth.subtitle')} />

      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
          <CardContent className="pt-6">
            <p className="text-red-800 dark:text-red-200">{error}</p>
          </CardContent>
        </Card>
      )}

      {/* API Keys Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Key className="h-5 w-5 text-emerald-600" />
              <CardTitle>{t('auth.apiKeys')}</CardTitle>
            </div>
            <Button onClick={() => setShowCreateApiKey(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              {t('auth.createKey')}
            </Button>
          </div>
          <CardDescription>
            {t('auth.manageKeysDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center gap-2 mb-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowApiKey(!showApiKey)}
                className="gap-2"
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                {showApiKey ? t('auth.hideKey') : t('auth.showKey')}
              </Button>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('common.name')}</TableHead>
                  <TableHead>{t('auth.key')}</TableHead>
                  <TableHead>{t('auth.permissions')}</TableHead>
                  <TableHead>{t('common.createdAt')}</TableHead>
                  <TableHead>{t('auth.lastUsed')}</TableHead>
                  <TableHead>{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apiKeys.map((apiKey) => (
                  <TableRow key={apiKey.id}>
                    <TableCell className="font-medium">{apiKey.name}</TableCell>
                    <TableCell>
                      <code className="bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded text-sm">
                        {maskApiKey(apiKey.key)}
                      </code>
                    </TableCell>
                    <TableCell>
                      {apiKey.permissions.map((perm: string) => (
                        <Badge key={perm} variant="outline" className="mr-1">{perm}</Badge>
                      ))}
                    </TableCell>
                    <TableCell>{new Date(apiKey.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell>{new Date(apiKey.lastUsed).toLocaleDateString()}</TableCell>
                    <TableCell>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDeleteApiKey(apiKey.key)}
                        className="gap-1"
                      >
                        <Trash2 className="h-3 w-3" />
                        {t('common.delete')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {apiKeys.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8">
                      <div className="text-muted-foreground">{t('auth.noApiKeys')}</div>
                      <Button
                        onClick={() => setShowCreateApiKey(true)}
                        className="mt-2 gap-2"
                        size="sm"
                      >
                        <Plus className="h-4 w-4" />
                        {t('auth.createFirstKey')}
                      </Button>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Tokens Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-amber-600" />
              <CardTitle>{t('auth.tokens')}</CardTitle>
            </div>
            <Button onClick={() => setShowCreateToken(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              {t('auth.generateToken')}
            </Button>
          </div>
          <CardDescription>
            {t('auth.manageTokensDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('auth.userId')}</TableHead>
                <TableHead>{t('auth.token')}</TableHead>
                <TableHead>{t('auth.permissions')}</TableHead>
                <TableHead>{t('auth.expiresAt')}</TableHead>
                <TableHead>{t('auth.lastUsed')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((token, index) => (
                <TableRow key={index}>
                  <TableCell className="font-medium">{token.userId}</TableCell>
                  <TableCell>
                    <code className="bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded text-sm">
                      {token.token}
                    </code>
                  </TableCell>
                  <TableCell>
                    {token.permissions.map((perm: string) => (
                      <Badge key={perm} variant="outline" className="mr-1">{perm}</Badge>
                    ))}
                  </TableCell>
                  <TableCell>{new Date(token.expiresAt).toLocaleString()}</TableCell>
                  <TableCell>{new Date(token.lastUsed).toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {tokens.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8">
                    <div className="text-muted-foreground">{t('auth.noActiveTokens')}</div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Create API Key Dialog */}
      <Dialog open={showCreateApiKey} onOpenChange={setShowCreateApiKey}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('auth.createKey')}</DialogTitle>
            <DialogDescription>
              {t('auth.createKeyDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">{t('auth.keyName')}</label>
              <Input
                value={newApiKey.name}
                onChange={(e) => setNewApiKey({ ...newApiKey, name: e.target.value })}
                placeholder={t('auth.keyNamePlaceholder')}
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('auth.permissions')}</label>
              <Select
                value={newApiKey.permissions[0]}
                onValueChange={(value) => setNewApiKey({ ...newApiKey, permissions: [value] })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('auth.selectPermissions')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">{t('auth.permRead')}</SelectItem>
                  <SelectItem value="write">{t('auth.permWrite')}</SelectItem>
                  <SelectItem value="admin">{t('auth.permAdmin')}</SelectItem>
                  <SelectItem value="*">{t('auth.permAll')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowCreateApiKey(false);
              setNewApiKey({ name: '', permissions: ['read'] });
            }}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreateApiKey}>
              {t('auth.createKey')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Token Dialog */}
      <Dialog open={showCreateToken} onOpenChange={setShowCreateToken}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('auth.generateToken')}</DialogTitle>
            <DialogDescription>
              {t('auth.generateTokenDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">{t('auth.userId')}</label>
              <Input
                value={newToken.userId}
                onChange={(e) => setNewToken({ ...newToken, userId: e.target.value })}
                placeholder={t('auth.userIdPlaceholder')}
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('auth.permissions')}</label>
              <Select
                value={newToken.permissions[0]}
                onValueChange={(value) => setNewToken({ ...newToken, permissions: [value] })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('auth.selectPermissions')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">{t('auth.permRead')}</SelectItem>
                  <SelectItem value="write">{t('auth.permWrite')}</SelectItem>
                  <SelectItem value="admin">{t('auth.permAdmin')}</SelectItem>
                  <SelectItem value="*">{t('auth.permAll')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">{t('auth.expiresInHours')}</label>
              <Input
                type="number"
                value={newToken.expiresInHours}
                onChange={(e) => setNewToken({ ...newToken, expiresInHours: parseInt(e.target.value) })}
                placeholder="24"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowCreateToken(false);
              setNewToken({ userId: '', permissions: ['read'], expiresInHours: 24 });
            }}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreateToken}>
              {t('auth.generateToken')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Authentication;
