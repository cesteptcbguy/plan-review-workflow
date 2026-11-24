import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';

export type MobileArtifact = { name: string; path: string };
export type MobileInteraction = { type: string; text: string; details?: string; responseTemplate?: string; humanProcedure?: boolean; canReopen?: boolean; phase?: { title: string; objective: string }; phases?: Array<{ title: string; objective: string; dependsOn: string[] }> };
export type MobileSnapshot = {
  checkpointId?: string;
  runId?: string;
  status: string;
  task: string;
  workflowName?: string;
  phaseName?: string;
  running: boolean;
  paused: boolean;
  canReturnToWorkflow?: boolean;
  interaction?: MobileInteraction;
  artifacts: MobileArtifact[];
};

export type MobileSettings = {
  enabled: boolean;
  ntfyServer: string;
  ntfyTopic: string;
};

export type MobileInfo = {
  enabled: boolean;
  ntfyServer?: string;
  ntfyTopic?: string;
  localUrl?: string;
  remoteUrl?: string;
  pairingCode?: string;
  tunnelActive: boolean;
  tunnelOwnedElsewhere: boolean;
  tunnelStatus: string;
  notificationStatus: string;
};

type ActionHandler = (type: string, humanInput?: string, index?: number) => Promise<void>;
type InfoHandler = (info: MobileInfo) => void;

export const allowedActions = new Set(['continue', 'continueCode', 'implementPlan', 'startNextPhase', 'reopenCompletedPhase', 'acceptRoadmap', 'startSplitPhase', 'continuePlanning', 'continueImplementation', 'runFinalVerification', 'completeAcceptance', 'continueWithoutGeneratedBaseline', 'startPrerequisiteWorkflow', 'recheckPrerequisite', 'pause', 'stop', 'resumeCurrent', 'returnToWorkflow']);

export function findDashboardUrl(text: string): string | undefined {
  const urls = text.match(/https:\/\/[^\s"']+\.devtunnels\.ms\/?/gi) ?? [];
  return urls.find(url => !/-inspect\./i.test(url));
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const cookies = String(request.headers.cookie ?? '').split(';');
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return;
}

async function readBody(request: IncomingMessage, limit = 128_000): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', chunk => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.length;
      if (size > limit) {
        reject(new Error('Request is too large.'));
        request.destroy();
        return;
      }
      chunks.push(value);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'"
  });
  response.end(body);
}

export function dashboardHtml(): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>CodeFlow Conductor</title><style>
  :root{color-scheme:dark}body{font:16px -apple-system,BlinkMacSystemFont,sans-serif;max-width:720px;margin:auto;padding:18px;background:#111;color:#eee}h1{font-size:22px}.card{border:1px solid #444;border-radius:12px;padding:14px;margin:12px 0;background:#1a1a1a}button,textarea,input{font:inherit;box-sizing:border-box;width:100%;padding:12px;margin-top:10px;border-radius:8px;border:1px solid #666;background:#242424;color:#fff}button{background:#0878b9;border:0;font-weight:600}button.secondary{background:#333}.muted{color:#aaa;font-size:13px}pre{white-space:pre-wrap;font:inherit}details{margin:12px 0;border:1px solid #444;border-radius:8px;padding:10px}summary{cursor:pointer;font-weight:600}details pre{font-size:14px;color:#ccc;line-height:1.45}a{color:#65bfff}#error{color:#ff9e9e}</style></head><body>
  <h1>CodeFlow Conductor</h1><div id="error"></div><div class="card"><strong id="status">Loading…</strong><p id="workflow"></p><details id="taskDetails"><summary>Show task details</summary><pre id="task" class="muted"></pre></details></div><div id="interaction" class="card" hidden><pre id="prompt"></pre><details id="promptDetails" hidden><summary>Show step-by-step instructions</summary><pre id="promptDetailsText"></pre></details><textarea id="answer" placeholder="Answer the question or give guidance"></textarea><div id="actions"></div></div><div class="card"><strong>Run controls</strong><button id="return" class="secondary" hidden>Return to parent workflow</button><button id="pause" class="secondary">Pause</button><button id="resume" class="secondary">Resume current run</button><button id="stop" class="secondary">Stop</button></div><div id="artifacts" class="card"><strong>Artifacts</strong><p class="muted">Open artifacts in VS Code on the Mac.</p></div>
  <script>
  const $=id=>document.getElementById(id);const instructionNewline=String.fromCharCode(10);const formatInstructions=value=>String(value||'').split(instructionNewline).map((line,index)=>index&&/^[0-9]+[.] /.test(line)?instructionNewline+line:line).join(instructionNewline);let state;let checkpointKey='';const actionLabels={continue:'Respond and continue planning',continueCode:'Respond and continue code review',implementPlan:'Implement approved plan',startNextPhase:'Plan next phase',reopenCompletedPhase:'Reopen completed phase with findings',acceptRoadmap:'Provisionally accept roadmap',continuePlanning:'Continue planning with guidance',continueImplementation:'Continue implementation for 3 more rounds',runFinalVerification:'Run remaining verification and final review',completeAcceptance:'Record acceptance results and complete phase',continueWithoutGeneratedBaseline:'Continue from approved source without generated baseline',startPrerequisiteWorkflow:'Start prerequisite workflow',recheckPrerequisite:'Recheck prerequisite',returnToWorkflow:'Return and recheck parent',resumeCurrent:'Retry failed stage'};
  function shortStatus(value){const text=String(value||'No active workflow');const quota=text.match(/You've hit your session limit[ \t]*[·-][ \t]*resets[ \t]+(.+)/i);return quota?'Claude usage limit reached. Retry after '+quota[1]+'.':text}
  async function invoke(type,index){if(type==='implementPlan'&&!confirm('Start implementation of the approved plan?'))return;if(type==='completeAcceptance'&&!confirm('Record these results as the final acceptance outcome and complete this phase?'))return;if(type==='reopenCompletedPhase'&&!confirm('Reopen this completed phase and block the next phase until remediation passes?'))return;if(type==='recheckPrerequisite'&&state?.interaction?.humanProcedure){const answer=$('answer').value.trim();if(!answer||answer===String(state.interaction.responseTemplate||'').trim()){throw new Error('Complete the prerequisite results before rechecking. Replace the template placeholders with your observations.')}}const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({checkpointId:state?.checkpointId,type,index,humanInput:$('answer').value})});if(!r.ok)throw new Error(await r.text());if(type==='acceptRoadmap')$('answer').value='';await refresh()}
  function actionsFor(interaction){if(!interaction)return[];if(interaction.type==='split'&&interaction.roadmapReady)return interaction.roadmapAccepted?[]:['acceptRoadmap'];const actions={needsInput:['continue'],codeNeedsInput:['continueCode'],readyToCode:['implementPlan'],nextPhase:['startNextPhase'],morePlanning:['continuePlanning'],moreCode:['continueImplementation'],verificationRequired:['runFinalVerification'],acceptancePending:['completeAcceptance'],requirementsFallback:['continueWithoutGeneratedBaseline'],prerequisitePending:['startPrerequisiteWorkflow','recheckPrerequisite'],prerequisiteComplete:['returnToWorkflow'],failed:['resumeCurrent']}[interaction.type]||[];if(interaction.canReopen)actions.push('reopenCompletedPhase');return actions}
  async function refresh(){try{const r=await fetch('/api/state');if(r.status===401){location.href='/pair';return}if(!r.ok)throw new Error(await r.text());state=await r.json();$('status').textContent=shortStatus(state.status);$('workflow').textContent=[state.workflowName,state.phaseName].filter(Boolean).join(' · ');$('workflow').hidden=!$('workflow').textContent;$('task').textContent=state.task||'';$('taskDetails').hidden=!$('task').textContent;const i=state.interaction;const nextCheckpointKey=JSON.stringify([state.checkpointId,state.workflowName,state.task,i?.type,i?.text,i?.details,i?.responseTemplate]);if(nextCheckpointKey!==checkpointKey){$('answer').value=i?.responseTemplate||'';checkpointKey=nextCheckpointKey}$('interaction').hidden=!i;if(i){$('prompt').textContent=i.type==='failed'?'The provider stopped. Use the button below after the limit resets.':i.text;$('promptDetails').hidden=!i.details;$('promptDetailsText').textContent=formatInstructions(i.details);const humanPrerequisite=i.type==='prerequisitePending'&&i.humanProcedure;$('answer').hidden=!(humanPrerequisite||i.canReopen||['needsInput','codeNeedsInput','acceptancePending','morePlanning','moreCode','verificationRequired','nextPhase','split','readyToCode'].includes(i.type));if(humanPrerequisite)$('answer').placeholder='Record each PASS, FAIL, or UNVERIFIED observation; replace every template placeholder';else if(i.canReopen)$('answer').placeholder='Paste the outside review findings that require this completed phase to be reopened';else if(i.type==='readyToCode')$('answer').placeholder='Optional approval guidance for the implementer';else if(i.type==='morePlanning')$('answer').placeholder='Paste an outside review or add guidance for the next planning round (optional)';else if(i.type==='nextPhase'||i.type==='split')$('answer').placeholder=i.type==='split'&&i.roadmapReady&&!i.roadmapAccepted?'Paste roadmap review notes, or phase-specific notes before choosing a phase':'Add notes for the phase planning run (optional)';else $('answer').placeholder='Answer the question or give guidance';if(!$('answer').value&&i.responseTemplate){$('answer').value=i.responseTemplate;$('answer').scrollTop=0}const box=$('actions');box.replaceChildren();for(const type of actionsFor(i)){if(humanPrerequisite&&type==='startPrerequisiteWorkflow')continue;const b=document.createElement('button');b.textContent=humanPrerequisite&&type==='recheckPrerequisite'?'Record results and recheck prerequisite':actionLabels[type];b.onclick=()=>invoke(type).catch(showError);box.appendChild(b)}if(i.type==='split')for(const [index,phase] of (i.phases||[]).entries()){const b=document.createElement('button');b.textContent='Plan phase '+(index+1)+': '+phase.title;b.onclick=()=>invoke('startSplitPhase',index).catch(showError);box.appendChild(b)}}$('return').hidden=!state.canReturnToWorkflow;$('return').disabled=state.running;$('pause').disabled=!state.running;$('resume').disabled=state.running||!state.paused;$('stop').disabled=!state.running;const a=$('artifacts');a.querySelectorAll('p.artifact').forEach(x=>x.remove());for(const artifact of state.artifacts||[]){const p=document.createElement('p');p.className='artifact muted';p.textContent=artifact.name;a.appendChild(p)}$('error').textContent=''}catch(e){showError(e)}}
  function showError(e){$('error').textContent=String(e?.message||e)}$('return').onclick=()=>invoke('returnToWorkflow').catch(showError);$('pause').onclick=()=>invoke('pause').catch(showError);$('resume').onclick=()=>invoke('resumeCurrent').catch(showError);$('stop').onclick=()=>invoke('stop').catch(showError);refresh();setInterval(refresh,4000);
  </script></body></html>`;
}

function pairingHtml(error = ''): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair CodeFlow Conductor</title><style>:root{color-scheme:dark}body{font:16px -apple-system,sans-serif;max-width:520px;margin:40px auto;padding:18px;background:#111;color:#eee}input,button{font:inherit;width:100%;box-sizing:border-box;padding:14px;margin-top:12px;border-radius:8px}button{background:#0878b9;color:#fff;border:0}.error{color:#ff9e9e}</style></head><body><h1>Pair this phone</h1><p>Enter the six-digit code shown in the CodeFlow sidebar on your Mac.</p><p class="error">${error}</p><form method="post" action="/pair"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required><button>Pair phone</button></form></body></html>`;
}

export class MobileBridge {
  private server?: Server;
  private tunnel?: ChildProcess;
  private snapshot: MobileSnapshot = { status: '', task: '', running: false, paused: false, artifacts: [] };
  private sessionToken = randomBytes(32).toString('hex');
  private pairingCode = String(Math.floor(100000 + Math.random() * 900000));
  private port?: number;
  private remoteUrl?: string;
  private tunnelRetry?: ReturnType<typeof setTimeout>;
  private tunnelId?: string;
  private tunnelCommand?: string;
  private tunnelOwnedElsewhere = false;
  private tunnelStopRequested = false;
  private lastTunnelOutput = '';
  private lastNotificationKey = '';
  private notificationStatus = 'Notifications are not configured.';
  private tunnelStatus = 'Mobile dashboard is not running.';

  constructor(private settings: MobileSettings, private readonly onAction: ActionHandler, private readonly onInfo: InfoHandler) {}

  updateSettings(settings: MobileSettings): void {
    this.settings = settings;
    this.notificationStatus = settings.enabled && settings.ntfyTopic
      ? 'Phone notifications are configured. Send a test alert to verify the subscription.'
      : 'Notifications are not configured.';
    this.onInfo(this.info());
  }

  updateState(snapshot: MobileSnapshot): void {
    const previous = JSON.stringify([this.snapshot.runId, this.snapshot.interaction]);
    const current = JSON.stringify([snapshot.runId, snapshot.interaction]);
    this.snapshot = { ...snapshot, checkpointId: previous === current && this.snapshot.checkpointId ? this.snapshot.checkpointId : randomBytes(24).toString('hex') };
    const interaction = snapshot.interaction;
    const attentionTypes = new Set(['needsInput', 'codeNeedsInput', 'readyToCode', 'nextPhase', 'split', 'morePlanning', 'childLimit', 'moreCode', 'verificationRequired', 'acceptancePending', 'requirementsFallback', 'prerequisitePending', 'prerequisiteComplete', 'codeReady', 'failed']);
    if (!this.settings.enabled || !interaction || !attentionTypes.has(interaction.type)) return;
    const key = `${interaction.type}:${interaction.text}`;
    if (key === this.lastNotificationKey) return;
    this.lastNotificationKey = key;
    const title = interaction.type === 'failed' ? 'CodeFlow stopped' : interaction.type === 'nextPhase' ? 'Next phase is ready' : 'CodeFlow needs attention';
    void this.notify(title, interaction.text.split('\n')[0].slice(0, 180));
  }

  info(): MobileInfo {
    return { enabled: this.settings.enabled, ntfyServer: this.settings.ntfyServer, ntfyTopic: this.settings.ntfyTopic, localUrl: this.port ? `http://127.0.0.1:${this.port}` : undefined, remoteUrl: this.remoteUrl, pairingCode: this.port ? this.pairingCode : undefined, tunnelActive: Boolean(this.tunnel || this.tunnelRetry), tunnelOwnedElsewhere: this.tunnelOwnedElsewhere, tunnelStatus: this.tunnelStatus, notificationStatus: this.notificationStatus };
  }

  setTunnelOwnedElsewhere(ownedElsewhere: boolean): void {
    this.tunnelOwnedElsewhere = ownedElsewhere;
    if (ownedElsewhere) this.tunnelStatus = 'Phone dashboard is already running from another VS Code window. Stop it there before starting one here.';
    this.onInfo(this.info());
  }

  async startServer(): Promise<MobileInfo> {
    if (this.server) return this.info();
    this.server = createServer((request, response) => { void this.handleRequest(request, response); });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : undefined;
    this.tunnelStatus = 'Local mobile dashboard is running. Install and sign in to devtunnel for phone access.';
    this.onInfo(this.info());
    return this.info();
  }

  async startTunnel(command: string): Promise<MobileInfo> {
    await this.startServer();
    if (this.tunnel || !this.port) return this.info();
    this.tunnelStopRequested = false;
    if (this.tunnelRetry) {
      clearTimeout(this.tunnelRetry);
      this.tunnelRetry = undefined;
    }
    this.remoteUrl = undefined;
    this.tunnelOwnedElsewhere = false;
    this.tunnelCommand = command;
    this.tunnelId = undefined;
    this.lastTunnelOutput = '';
    this.tunnelStatus = 'Starting authenticated Microsoft dev tunnel…';
    this.onInfo(this.info());
    this.tunnel = spawn(command, ['host', '-p', String(this.port), '--expiration', '1h'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const inspect = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.lastTunnelOutput = `${this.lastTunnelOutput}\n${text}`.trim().slice(-2_000);
      const url = findDashboardUrl(text);
      const id = /Ready to accept connections for tunnel:\s*([^\s]+)/i.exec(text)?.[1];
      if (id) this.tunnelId = id;
      if (url) {
        this.remoteUrl = url;
        this.tunnelStatus = 'Authenticated mobile dashboard is available.';
        this.onInfo(this.info());
      } else if (/login|not logged|authentication|unauthorized/i.test(text)) {
        this.tunnelStatus = 'Microsoft dev tunnel sign-in is required.';
        this.onInfo(this.info());
      } else if (/rate limit exceeded/i.test(text)) {
        this.tunnelStatus = 'Microsoft dev tunnel rate limit reached. Retrying automatically in about one minute…';
        this.onInfo(this.info());
      }
    };
    this.tunnel.stdout?.on('data', inspect);
    this.tunnel.stderr?.on('data', inspect);
    this.tunnel.on('exit', code => {
      const tunnelId = this.tunnelId;
      const tunnelCommand = this.tunnelCommand;
      this.tunnel = undefined;
      const rateLimited = /rate limit exceeded/i.test(this.lastTunnelOutput);
      const lastLine = this.lastTunnelOutput.split('\n').map(line => line.trim()).filter(Boolean).at(-1);
      if (rateLimited && !this.tunnelStopRequested) {
        this.tunnelStatus = 'Microsoft dev tunnel rate limit reached. Retrying automatically in about one minute…';
        this.tunnelRetry = setTimeout(() => {
          this.tunnelRetry = undefined;
          void this.startTunnel(command);
        }, 70_000);
      } else if (this.tunnelStopRequested) this.tunnelStatus = 'Phone dashboard is stopped.';
      else if (!this.remoteUrl) this.tunnelStatus = lastLine
        ? `Dev tunnel stopped: ${lastLine}`
        : `Dev tunnel stopped${code === null ? '' : ` with exit code ${code}`}.`;
      else this.tunnelStatus = 'Dev tunnel stopped.';
      this.remoteUrl = undefined;
      this.tunnelId = undefined;
      this.onInfo(this.info());
      if (tunnelId && tunnelCommand) {
        const cleanup = spawn(tunnelCommand, ['delete', tunnelId], { stdio: 'ignore' });
        cleanup.unref();
      }
    });
    this.tunnel.on('error', error => {
      this.tunnelStatus = `Dev tunnel could not start: ${error.message}`;
      this.onInfo(this.info());
    });
    return this.info();
  }

  stopTunnel(): void {
    this.tunnelStopRequested = true;
    if (this.tunnelRetry) clearTimeout(this.tunnelRetry);
    this.tunnelRetry = undefined;
    const tunnel = this.tunnel;
    if (tunnel) {
      tunnel.kill('SIGTERM');
      const force = setTimeout(() => { if (this.tunnel === tunnel) tunnel.kill('SIGKILL'); }, 5_000);
      force.unref();
    } else {
      this.remoteUrl = undefined;
      this.tunnelStatus = 'Phone dashboard is stopped.';
      this.onInfo(this.info());
    }
  }

  async notify(title: string, message: string): Promise<void> {
    if (!this.settings.enabled || !this.settings.ntfyTopic) return;
    const server = this.settings.ntfyServer.replace(/\/$/, '');
    try {
      const response = await fetch(`${server}/${encodeURIComponent(this.settings.ntfyTopic)}`, {
        method: 'POST',
        headers: { Title: title, Priority: 'high', Tags: 'computer', ...(this.remoteUrl ? { Click: this.remoteUrl } : {}) },
        body: message
      });
      if (!response.ok) throw new Error(`ntfy returned ${response.status}`);
      this.notificationStatus = 'Last phone notification sent successfully.';
    } catch (error) {
      this.notificationStatus = `Phone notification failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.onInfo(this.info());
  }

  regeneratePairingCode(): string {
    this.pairingCode = String(Math.floor(100000 + Math.random() * 900000));
    this.sessionToken = randomBytes(32).toString('hex');
    this.onInfo(this.info());
    return this.pairingCode;
  }

  dispose(): void {
    this.stopTunnel();
    this.server?.close();
  }

  private authenticated(request: IncomingMessage): boolean {
    const session = cookieValue(request, 'plan_review_session');
    return Boolean(session && constantTimeEqual(session, this.sessionToken));
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://localhost');
      if (requestUrl.pathname === '/pair' && request.method === 'GET') {
        send(response, 200, 'text/html; charset=utf-8', pairingHtml());
        return;
      }
      if (requestUrl.pathname === '/pair' && request.method === 'POST') {
        const params = new URLSearchParams(await readBody(request));
        const code = params.get('code') ?? '';
        if (!constantTimeEqual(code, this.pairingCode)) {
          send(response, 403, 'text/html; charset=utf-8', pairingHtml('That pairing code is not valid.'));
          return;
        }
        response.writeHead(303, {
          Location: '/',
          'Set-Cookie': `plan_review_session=${encodeURIComponent(this.sessionToken)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
          'Cache-Control': 'no-store'
        });
        response.end();
        return;
      }
      if (!this.authenticated(request)) {
        if (requestUrl.pathname.startsWith('/api/')) send(response, 401, 'text/plain; charset=utf-8', 'Pair this phone first.');
        else { response.writeHead(303, { Location: '/pair', 'Cache-Control': 'no-store' }); response.end(); }
        return;
      }
      if (requestUrl.pathname === '/' && request.method === 'GET') {
        send(response, 200, 'text/html; charset=utf-8', dashboardHtml());
        return;
      }
      if (requestUrl.pathname === '/api/state' && request.method === 'GET') {
        send(response, 200, 'application/json; charset=utf-8', JSON.stringify(this.snapshot));
        return;
      }
      if (requestUrl.pathname === '/api/action' && request.method === 'POST') {
        const origin = request.headers.origin;
        if (origin && new URL(origin).host !== request.headers.host) {
          send(response, 403, 'text/plain; charset=utf-8', 'Request origin was rejected.');
          return;
        }
        const data = JSON.parse(await readBody(request)) as { checkpointId?: unknown; type?: unknown; humanInput?: unknown; index?: unknown };
        if (!data.checkpointId || data.checkpointId !== this.snapshot.checkpointId) {
          send(response, 409, 'text/plain; charset=utf-8', 'This checkpoint changed. Refresh the dashboard and enter results for the current checkpoint.');
          return;
        }
        const type = String(data.type ?? '');
        if (!allowedActions.has(type)) {
          send(response, 400, 'text/plain; charset=utf-8', 'Unsupported workflow action.');
          return;
        }
        const index = Number(data.index);
        await this.onAction(type, String(data.humanInput ?? '').trim(), Number.isInteger(index) ? index : undefined);
        send(response, 200, 'application/json; charset=utf-8', '{"ok":true}');
        return;
      }
      send(response, 404, 'text/plain; charset=utf-8', 'Not found.');
    } catch (error) {
      send(response, 500, 'text/plain; charset=utf-8', error instanceof Error ? error.message : String(error));
    }
  }
}
