import React, { useEffect, useMemo, useState } from 'react';
import { apiClient, type ServiceInstance } from '../api/client';
import PageHeader from '@/components/PageHeader';
import { useI18n } from '@/i18n';
import { useToastHelpers } from '@/components/ui/toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Copy, Plug } from 'lucide-react';

const Integrations: React.FC = () => {
  const { t } = useI18n();
  const { success, error: showError } = useToastHelpers();
  const [services, setServices] = useState<ServiceInstance[]>([]);
  const [selectedService, setSelectedService] = useState<string>('');
  const [previewing, setPreviewing] = useState<boolean>(false);
  const [applying, setApplying] = useState<boolean>(false);
  const [discovered, setDiscovered] = useState<any[]>([]);
  const [apiKeys, setApiKeys] = useState<any[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [newKeyName, setNewKeyName] = useState<string>('gateway-client');
  const [newKeyPerm, setNewKeyPerm] = useState<string>('read');
  // Local MCP Proxy pairing
  const [verificationCode, setVerificationCode] = useState<string>('');
  const [codeExpiresIn, setCodeExpiresIn] = useState<number>(0);
  const [pairing, setPairing] = useState<{ handshakeId?: string; clientNonce?: string; serverNonce?: string; sessionToken?: string; sessionExpiresIn?: number }>({});
  const [tools, setTools] = useState<any[]>([]);
  const [toolName, setToolName] = useState<string>('');
  const [toolArgs, setToolArgs] = useState<string>('{}');

  useEffect(() => {
    (async () => {
      const res = await apiClient.getServices();
      if (res.ok && res.data && res.data.length) {
        setServices(res.data);
        setSelectedService(res.data[0].id);
      }
    })();
  }, []);

  const refreshKeys = async () => {
    const res = await apiClient.listApiKeys();
    if (res.ok) {
      setApiKeys(res.data || []);
      if (!selectedKey && (res.data || []).length > 0) {
        const firstKey = (res.data as any[])[0]?.key || '';
        setSelectedKey(firstKey);
      }
    }
  };

  useEffect(() => {
    refreshKeys();
  }, []);

  const baseUrl = useMemo(() => {
    if (typeof window !== 'undefined' && window.location) return window.location.origin;
    return 'http://localhost:19233';
  }, []);

  const svc = useMemo(() => services.find(s => s.id === selectedService), [services, selectedService]);

  const snippets = useMemo(() => {
    const sid = selectedService || '<serviceId>';
    const httpUrl = `${baseUrl}/api/proxy/${sid}`;
    const compatUrl = `${baseUrl}/mcp/${sid}`;
    const key = selectedKey || '<API_KEY>';
    return {
      claude: `{
  "transport": "http",
  "url": "${compatUrl}",
  "headers": { "Authorization": "Bearer ${key}" }
}`,
      cursor: `{
  "transport": "http",
  "url": "${compatUrl}",
  "headers": { "Authorization": "Bearer ${key}" }
}`,
      cline: `{
  "transport": "http",
  "url": "${compatUrl}",
  "headers": { "Authorization": "Bearer ${key}" }
}`,
      windsurf: `{
  "transport": "http",
  "url": "${compatUrl}",
  "headers": { "Authorization": "Bearer ${key}" }
}`,
      vscode: `{
  "mcp.servers": [
    {
      "name": "${svc?.config?.name || 'my-service'}",
      "transport": "http",
      "url": "${compatUrl}",
      "headers": { "Authorization": "Bearer ${key}" }
    }
  ]
}`,
      curl: `curl -H \"Authorization: Bearer ${key}\" \\
  -H \"Content-Type: application/json\" \\
  -X POST ${httpUrl} \\
  -d '{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"tools/list\"}'`
    };
  }, [selectedService, services, baseUrl, selectedKey]);

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); success('已复制'); } catch { showError('复制失败'); }
  };

  const previewImport = async () => {
    setPreviewing(true);
    const res = await apiClient.previewExternalConfigs();
    setPreviewing(false);
    if (res.ok) setDiscovered(res.data || []);
    else showError(t('common.unknownError'));
  };

  const applyImport = async () => {
    setApplying(true);
    const res = await apiClient.applyExternalConfigs();
    setApplying(false);
    if (res.ok) success(t('integrations.import.applySuccess') || '已应用');
    else showError(res.error || t('common.unknownError'));
  };

  const createKey = async () => {
    const perms = newKeyPerm ? [newKeyPerm] : ['read'];
    const res = await apiClient.createApiKey(newKeyName || 'gateway-client', perms);
    if (res.ok && (res.data as any)?.apiKey) {
      await refreshKeys();
      setSelectedKey((res.data as any).apiKey);
      success(t('integrations.apiKey.created') || '已生成 API Key');
    } else {
      showError(t('integrations.apiKey.createFail') || '创建失败');
    }
  };

  // ===== Local MCP Proxy helpers =====
  const te = new TextEncoder();
  const bytesToHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  const bytesToBase64 = (buf: ArrayBuffer) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };
  const base64ToBytes = (b64: string) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  };
  const sha256Hex = async (text: string) => {
    const digest = await crypto.subtle.digest('SHA-256', te.encode(text));
    return bytesToHex(digest);
  };
  const deriveKeyPbkdf2 = async (code: string, serverNonceB64: string, iterations: number, length = 32) => {
    const keyMaterial = await crypto.subtle.importKey('raw', te.encode(code), { name: 'PBKDF2' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations, salt: base64ToBytes(serverNonceB64) }, keyMaterial, length * 8);
    return bits;
  };
  const hmacSha256Base64 = async (keyBytes: ArrayBuffer, data: string) => {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, te.encode(data));
    return bytesToBase64(sig);
  };

  const fetchCode = async () => {
    try {
      const r = await fetch('/local-proxy/code');
      const j = await r.json();
      setVerificationCode(j.code || '');
      setCodeExpiresIn(Number(j.expiresIn || 0));
    } catch {}
  };

  useEffect(() => { fetchCode(); }, []);

  const oneClickPair = async () => {
    try {
      await fetchCode();
      const code = verificationCode;
      const origin = window.location.origin;
      // generate clientNonce (16 bytes, b64)
      const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
      const clientNonce = bytesToBase64(nonceBytes.buffer);
      const codeProof = await sha256Hex(`${code}|${origin}|${clientNonce}`);
      // init
      const r1 = await fetch('/handshake/init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientNonce, codeProof }) });
      if (!r1.ok) { showError('握手初始化失败'); return; }
      const j1 = await r1.json();
      const { handshakeId, serverNonce, kdf, kdfParams } = j1;
      setPairing(p => ({ ...p, handshakeId, clientNonce, serverNonce }));
      // approve
      const r2 = await fetch('/handshake/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handshakeId, approve: true }) });
      if (!r2.ok) { showError('批准失败'); return; }
      // confirm
      let keyBits: ArrayBuffer;
      if (kdf === 'pbkdf2') {
        keyBits = await deriveKeyPbkdf2(code, serverNonce, kdfParams?.iterations || 200000, kdfParams?.length || 32);
      } else {
        // fallback to pbkdf2 if not supported
        keyBits = await deriveKeyPbkdf2(code, serverNonce, 200000, 32);
      }
      const response = await hmacSha256Base64(keyBits, `${origin}|${clientNonce}|${handshakeId}`);
      const r3 = await fetch('/handshake/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handshakeId, response }) });
      if (!r3.ok) { showError('确认失败'); return; }
      const j3 = await r3.json();
      setPairing(p => ({ ...p, sessionToken: j3.sessionToken, sessionExpiresIn: j3.expiresIn }));
      success('本地代理配对成功');
    } catch (e) {
      showError(e instanceof Error ? e.message : '配对失败');
    }
  };

  const listTools = async () => {
    if (!pairing.sessionToken) { showError('请先完成配对'); return; }
    const url = selectedService ? `/tools?serviceId=${encodeURIComponent(selectedService)}` : '/tools';
    const r = await fetch(url, { headers: { Authorization: `LocalMCP ${pairing.sessionToken}` } });
    const j = await r.json();
    if (j.success) setTools(j.tools || []);
    else showError(j.error || '获取工具失败');
  };

  const callTool = async () => {
    if (!pairing.sessionToken) { showError('请先完成配对'); return; }
    if (!toolName) { showError('请输入工具名称'); return; }
    let args: any = {};
    try { args = toolArgs ? JSON.parse(toolArgs) : {}; } catch { showError('参数 JSON 非法'); return; }
    const body = { tool: toolName, params: args, serviceId: selectedService || undefined };
    const r = await fetch('/call', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `LocalMCP ${pairing.sessionToken}` }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!j.success) { showError(j.error || '调用失败'); return; }
    success('调用成功');
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('integrations.title')}
        description={t('integrations.desc')}
        icon={<Plug className="h-6 w-6 text-primary" />}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('integrations.generator.title')}</CardTitle>
          <CardDescription>{t('integrations.generator.desc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div>
              <label className="text-sm font-medium">{t('integrations.selectService')}</label>
              <Select value={selectedService} onValueChange={setSelectedService}>
                <SelectTrigger>
                  <SelectValue placeholder={t('integrations.selectService')} />
                </SelectTrigger>
                <SelectContent>
                  {services.map(s => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.config.name} <span className="text-xs text-slate-500">({s.id.slice(0,8)})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">{t('integrations.apiKey.select')}</label>
              <div className="flex gap-2">
                <Select value={selectedKey} onValueChange={setSelectedKey}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('integrations.apiKey.select')} />
                  </SelectTrigger>
                  <SelectContent>
                    {apiKeys.map((k: any) => (
                      <SelectItem key={k.key} value={k.key}>{k.name} <span className="text-xs text-slate-500">({k.key.slice(0,8)}...)</span></SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="outline" onClick={refreshKeys}>{t('common.refresh')}</Button>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium">{t('integrations.apiKey.create')}</label>
              <div className="flex gap-2 mt-1">
                <Input className="w-1/2" placeholder={t('integrations.apiKey.name') || '名称'} value={newKeyName} onChange={e => setNewKeyName(e.target.value)} />
                <Select value={newKeyPerm} onValueChange={setNewKeyPerm}>
                  <SelectTrigger className="w-1/4">
                    <SelectValue placeholder={t('integrations.apiKey.perm')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read">read</SelectItem>
                    <SelectItem value="write">write</SelectItem>
                    <SelectItem value="admin">admin</SelectItem>
                    <SelectItem value="*">*</SelectItem>
                  </SelectContent>
                </Select>
                <Button onClick={createKey}>{t('integrations.apiKey.generate')}</Button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { key: 'claude', label: 'Claude Desktop' },
              { key: 'cursor', label: 'Cursor' },
              { key: 'cline', label: 'Cline' },
              { key: 'windsurf', label: 'Windsurf' },
              { key: 'vscode', label: 'VS Code' },
              { key: 'curl', label: 'curl' },
            ].map(({ key, label }) => (
              <div key={key} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">{label}</div>
                  <Button variant="outline" size="sm" className="gap-2" onClick={() => copy((snippets as any)[key])}><Copy className="h-4 w-4" />{t('common.copy') || '复制'}</Button>
                </div>
                <Textarea rows={key === 'curl' ? 5 : 10} value={(snippets as any)[key]} readOnly className="font-mono text-xs" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('integrations.import.title')}</CardTitle>
          <CardDescription>{t('integrations.import.desc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 mb-4">
            <Button onClick={previewImport} disabled={previewing}>{t('integrations.import.preview')}</Button>
            <Button variant="secondary" onClick={applyImport} disabled={applying || discovered.length === 0}>{t('integrations.import.apply')}</Button>
          </div>
          {discovered.length > 0 && (
            <div className="space-y-2">
              {discovered.map((g, i) => (
                <div key={i} className="text-sm text-muted-foreground">
                  [{g.source}] {g.path} - {Array.isArray(g.items) ? g.items.length : 0} items
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('integrations.localProxy.title')}</CardTitle>
          <CardDescription>{t('integrations.localProxy.desc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <div className="text-sm text-muted-foreground">{t('integrations.localProxy.code')}</div>
              <div className="text-2xl font-mono">{verificationCode || '--------'}</div>
              <div className="text-xs text-muted-foreground">{t('integrations.localProxy.expiresIn')}: {codeExpiresIn}s</div>
              <div className="mt-2 flex gap-2">
                <Button variant="outline" onClick={fetchCode}>{t('common.refresh')}</Button>
                <Button onClick={oneClickPair}>{t('integrations.localProxy.pair')}</Button>
              </div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground">{t('integrations.localProxy.token')}</div>
              <div className="text-xs break-all select-all">{pairing.sessionToken ? pairing.sessionToken : '-'}</div>
              <div className="text-xs text-muted-foreground">{t('integrations.localProxy.ttl')}: {pairing.sessionExpiresIn ?? '-'}s</div>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={listTools}>{t('integrations.localProxy.listTools')}</Button>
                <span className="text-xs text-muted-foreground">{Array.isArray(tools) ? tools.length : 0} {t('integrations.localProxy.items')}</span>
              </div>
              <div className="text-xs font-mono whitespace-pre-wrap break-all border rounded-md p-2 bg-background" style={{ minHeight: 80 }}>{JSON.stringify(tools, null, 2)}</div>
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium">{t('integrations.localProxy.callTool')}</div>
              <Input placeholder={t('integrations.localProxy.toolName') || '工具名称'} value={toolName} onChange={e => setToolName(e.target.value)} />
              <Textarea className="font-mono text-xs" rows={5} placeholder="{}" value={toolArgs} onChange={e => setToolArgs(e.target.value)} />
              <Button onClick={callTool} className="w-full">{t('integrations.localProxy.call')}</Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Integrations;
