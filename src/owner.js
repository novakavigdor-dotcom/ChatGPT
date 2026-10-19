import {CATEGORIES} from './loyalty.js';
import {startQrScanner} from './qr.js';

const ownerEscape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ownerIcon=(name,cls='')=>`<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const ownerScanIcon=`<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M16 6H8a2 2 0 0 0-2 2v8m26-10h8a2 2 0 0 1 2 2v8M6 32v8a2 2 0 0 0 2 2h8m16 0h8a2 2 0 0 0 2-2v-8M6 24h36"/><path d="M14 14h7v7h-7zm13 0h7v7h-7zM14 27h7v7h-7zm13 0h3v3h4v4h-7z"/></svg>`;

function ownerReadCode(value){
  const raw=String(value??'').trim();
  const plain=raw.replace(/^UMAMI\s*:/i,'').replace(/[\s-]/g,'');
  if(/^[a-f\d]{32}$/i.test(plain))return plain.toUpperCase();
  const prefix=raw.match(/^umami(?::passport)?:([a-f\d]{32})$/i);
  if(prefix)return prefix[1].toUpperCase();
  try{
    const url=new URL(raw);
    const code=url.searchParams.get('passport')||url.searchParams.get('code');
    if(code&&/^[a-f\d]{32}$/i.test(code))return code.toUpperCase();
  }catch{}
  throw new Error('That is not an Umami Passport code. Scan the customer’s QR code or paste their 32-character code.');
}

export function mountOwner({container,api,onExit,toast=()=>{},offline=false}){
  let disposed=false,authenticated=false,configured=true,customer=null,scanner=null,cameraController=null,cameraStarting=false,lookupBusy=false,authBusy=false,saveBusy=false,modalCustomer=null,lastError='',pendingVisit=null;
  const pendingVisits=new Map();
  const select=selector=>container.querySelector(selector);
  const statusLabel=offline?'Offline demo · same browser only':'OWNER WORKSPACE';
  const errorText=error=>error?.message||'Something went wrong. Please try again.';
  const uuid=()=>globalThis.crypto?.randomUUID?.()||'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const n=Math.floor(Math.random()*16);return(c==='x'?n:(n&3)|8).toString(16);});

  function stopCamera(){
    cameraController?.abort();cameraController=null;
    scanner?.stop();scanner=null;cameraStarting=false;
    const video=select('[data-ow-video]');
    if(video?.srcObject){video.srcObject.getTracks().forEach(track=>track.stop());video.srcObject=null;}
    if(!disposed){
      const panel=select('[data-ow-camera]');if(panel)panel.classList.remove('is-scanning');
      const button=select('[data-ow-action="camera"]');if(button){button.disabled=false;button.innerHTML=`${ownerScanIcon}Start scanner`;}
      const stop=select('[data-ow-action="stop-camera"]');if(stop)stop.hidden=true;
    }
  }

  function header(){return `<div class="ow-heading"><div><div class="ow-kicker"><span></span>${statusLabel}</div><h1>A little scan.<br><em>A new discovery.</em></h1><p>Check a purchase. Stamp their passport.<br>Keep the good taste going.</p></div><div class="ow-header-actions"><button class="ow-quiet" data-ow-action="exit">${ownerIcon('arrow')}Customer version</button>${authenticated&&!offline?`<button class="ow-signout" data-ow-action="logout">Sign out</button>`:''}</div></div>`;}
  function shell(contents){
    stopCamera();
    container.innerHTML=`<section class="ow-workspace">${header()}${contents}</section><dialog id="owner-modal" class="ow-dialog" aria-labelledby="ow-modal-title"><div data-ow-modal-content></div></dialog>`;
    select('#owner-modal').addEventListener('cancel',onDialogCancel);
    select('#owner-modal').addEventListener('close',()=>{stopCamera();if(!saveBusy)modalCustomer=null;});
  }
  function showError(message){const el=select('[data-ow-error]');if(el){el.textContent=message;el.hidden=!message;}}
  function showLoading(){shell(`<div class="ow-loading" role="status"><span class="ow-loading-dot"></span>Opening your owner workspace…</div>`);}
  function showAuth(){
    authenticated=false;
    shell(`<div class="ow-auth-layout"><div class="ow-auth-card"><span class="ow-auth-seal">${ownerIcon('lock')}</span><div class="ow-kicker">FOR THE PEOPLE BEHIND THE COUNTER</div><h2>${configured?'Welcome back.':'Make it yours.'}</h2><p>${configured?'Sign in to scan customer passports and approve their purchases.':'Set an owner password before sharing this app with customers. Only the owner can add stamps and confirm rewards.'}</p><form data-ow-form="auth"><label for="ow-password">${configured?'Owner password':'Create owner password'}</label><input id="ow-password" name="password" type="password" autocomplete="${configured?'current-password':'new-password'}" minlength="${configured?1:10}" maxlength="256" required placeholder="${configured?'Enter your password':'At least 10 characters'}"><p class="ow-form-error" data-ow-error role="alert" hidden></p><button type="submit" class="ow-primary">${configured?'Open owner workspace':'Set password & continue'}${ownerIcon('arrow')}</button></form><span class="ow-auth-note">${ownerIcon('lock')}${configured?'Your customers keep their own passport. This screen is just for you.':'Keep this password private. Customers never need it.'}</span></div><aside class="ow-auth-story"><div class="ow-big-seal">${ownerIcon('passport')}</div><h2>From their screen<br>to a new stamp.</h2><ol><li><b>01</b><span>A customer shows you their personal QR code.</span></li><li><b>02</b><span>You scan it and choose what they ordered.</span></li><li><b>03</b><span>Their passport updates with each new discovery.</span></li></ol></aside></div>`);
  }
  function summaryMarkup(value){
    const count=CATEGORIES.filter(c=>value.stamps?.[c.id]).length;
    return `<div class="ow-customer-summary"><div class="ow-customer-top"><div class="ow-customer-avatar">${ownerEscape((value.name||'G').charAt(0).toUpperCase())}</div><div><div class="ow-kicker">LAST PASSPORT</div><h3>${ownerEscape(value.name||'Umami guest')}</h3><span>${count} of 6 discoveries collected</span></div><span class="ow-verified">${ownerIcon('check')}Updated</span></div><div class="ow-mini-stamps">${CATEGORIES.map(c=>`<div class="${value.stamps?.[c.id]?'is-collected':''}" title="${ownerEscape(c.name)}: ${value.stamps?.[c.id]?'collected':'waiting'}">${ownerIcon(c.icon)}<span>${ownerEscape(c.name)}</span>${value.stamps?.[c.id]?'<b aria-label="Collected">✓</b>':''}</div>`).join('')}</div><div class="ow-summary-bottom"><span>${value.redeemed?'Reward redeemed':count===6?'All six collected · reward available':'A little closer to the secret roll.'}</span><button class="ow-quiet" data-ow-action="review">Review passport ${ownerIcon('arrow')}</button></div></div>`;
  }
  function showDashboard(){
    authenticated=true;
    shell(`${offline?'<div class="ow-demo-note">Offline demo: scan and stamp the customer passport saved in this browser. To use separate phones, run the hosted app and share its secure website address.</div>':''}<div class="ow-dashboard"><section class="ow-scan-card"><div class="ow-card-heading"><div><div class="ow-kicker">ONE CUSTOMER. THEIR OWN PASSPORT.</div><h2>Ready when they are.</h2></div><span class="ow-step-tag">01 → 02 → 03</span></div><div class="ow-camera" data-ow-camera><video data-ow-video playsinline muted aria-label="Live camera QR scanner"></video><div class="ow-camera-idle"><div class="ow-scan-art">${ownerScanIcon}</div><h3>Point. Scan. Stamp.</h3><p>Ask the customer to open their passport<br>and show you their QR code.</p></div><div class="ow-viewfinder" aria-hidden="true"><i></i><i></i><i></i><i></i></div><div class="ow-scanning-label">Looking for an Umami Passport…</div></div><div class="ow-camera-actions"><button class="ow-primary" data-ow-action="camera">${ownerScanIcon}Start scanner</button><button class="ow-quiet" data-ow-action="stop-camera" hidden>Stop camera</button><span data-ow-camera-hint>${ownerIcon('lock')}Camera starts only when you tap.</span></div><p class="ow-form-error" data-ow-camera-error role="alert" hidden></p><div class="ow-manual-divider"><span>or enter their code</span></div><form data-ow-form="lookup" class="ow-lookup-form"><label for="ow-code">CUSTOMER PASSPORT CODE</label><div><input id="ow-code" name="code" type="text" spellcheck="false" autocomplete="off" autocapitalize="characters" required placeholder="Paste their code or QR link" aria-describedby="ow-code-help"><button class="ow-secondary" type="submit">Look up passport ${ownerIcon('arrow')}</button></div><small id="ow-code-help">Find the code below the QR on the customer’s screen.</small><p class="ow-form-error" data-ow-error role="alert" hidden></p></form></section><aside class="ow-how-card"><div class="ow-kicker">GOOD TASTE. A SIMPLE ROUTINE.</div><h2>Three little steps.</h2><ol><li><span>1</span><div><h3>Find their passport.</h3><p>Scan the customer’s personal QR code, or enter their passport code.</p></div></li><li><span>2</span><div><h3>Pick their discoveries.</h3><p>Choose every category they purchased. More than one? Tick them all.</p></div></li><li><span>3</span><div><h3>A little “okay”.</h3><p>Confirm the purchase. New stamps appear on their passport automatically.</p></div></li></ol><div class="ow-how-note">${ownerIcon('check')}Already collected stamps stay marked. Each category counts once.</div></aside></div><section data-ow-last>${customer?summaryMarkup(customer):'<div class="ow-empty-recent">'+ownerIcon('passport')+'<span>Your first scan is waiting. Their next favourite is, too.</span></div>'}</section>`);
  }
  async function authenticate(form){
    if(authBusy)return;authBusy=true;
    const button=form.querySelector('button');button.disabled=true;showError('');
    try{
      await api(configured?'/api/owner/login':'/api/owner/setup',{method:'POST',body:{password:new FormData(form).get('password')}});
      if(disposed)return;
      configured=true;showDashboard();
    }catch(error){if(!disposed)showError(errorText(error));}
    finally{authBusy=false;if(button.isConnected)button.disabled=false;}
  }
  async function lookup(value){
    if(lookupBusy)return;
    stopCamera();showError('');
    let code;try{code=ownerReadCode(value);}catch(error){showError(errorText(error));return;}
    lookupBusy=true;
    const button=select('[data-ow-form="lookup"] button');if(button){button.disabled=true;button.textContent='Finding passport…';}
    try{
      const result=await api(`/api/owner/customer?code=${encodeURIComponent(code)}`);
      if(disposed)return;
      customer=result.customer;openCustomer(customer);
    }catch(error){
      if(disposed)return;
      showError(errorText(error));
      if(error?.status===401){authenticated=false;showAuth();showError('Please sign in again to scan passports.');}
    }finally{lookupBusy=false;if(button?.isConnected){button.disabled=false;button.innerHTML=`Look up passport ${ownerIcon('arrow')}`;}}
  }
  function modalMarkup(value){
    const count=CATEGORIES.filter(c=>value.stamps?.[c.id]).length;
    const remembered=pendingVisits.get(value.code);
    const locked=Boolean(remembered);
    pendingVisit=remembered||null;
    return `<div class="ow-modal-header"><div class="ow-kicker">VERIFY THE PURCHASE</div><button class="ow-modal-close" data-ow-action="close-modal" aria-label="Close passport">${ownerIcon('close')}</button></div><h2 id="ow-modal-title">What did they get?</h2><div class="ow-modal-person"><span class="ow-customer-avatar">${ownerEscape((value.name||'G').charAt(0).toUpperCase())}</span><div><b>${ownerEscape(value.name||'Umami guest')}</b><span>${count} of 6 stamps collected · ${ownerEscape(value.code.slice(0,4))}…${ownerEscape(value.code.slice(-4))}</span></div></div><p class="ow-modal-intro">Select every category in this purchase.<br>We’ll mark each new discovery on their passport.</p><form data-ow-form="stamps"><fieldset class="ow-category-grid" ${locked?'disabled':''}><legend class="ow-sr-only">Categories purchased</legend>${CATEGORIES.map(c=>{const collected=Boolean(value.stamps?.[c.id]),checked=remembered?.categories.includes(c.id);return `<label class="ow-category-option ${collected?'is-collected':''}"><input type="checkbox" name="categories" value="${c.id}" ${collected?'disabled':''} ${checked?'checked':''}><span class="ow-option-icon">${ownerIcon(c.icon)}</span><span class="ow-option-copy"><b>${ownerEscape(c.name)}</b><small>${collected?'Already collected':ownerEscape(c.description)}</small></span><span class="ow-option-tick" aria-hidden="true">${collected?'✓':''}</span></label>`;}).join('')}</fieldset><label class="ow-direct-option"><input type="checkbox" name="directOrder" ${remembered?.directOrder?'checked':''} ${locked?'disabled':''}>${ownerIcon('bag')}<span><b>They ordered directly with Umami</b><small>Add a direct-order badge for this visit.</small></span></label><p class="ow-modal-error" data-ow-save-error role="alert" ${locked?'':'hidden'}>${locked?'This visit has an unconfirmed save. Retry to check the same purchase without adding it twice.':''}</p><button class="ow-primary ow-full" type="submit" data-ow-confirm ${!locked?'disabled':''}>${locked?'Retry confirmation':'Okay, add stamps'} ${ownerIcon('check')}</button><p class="ow-save-note">${count===6?'Every category is already collected. You can confirm their reward below.':'Only select categories from a purchase you have checked.'}</p></form>${count===6?`<div class="ow-redeem-box">${ownerIcon('gift')}<div><b>${value.redeemed?'Reward already redeemed':'Secret Passport Roll unlocked'}</b><p>${value.redeemed?'This passport’s reward has already been confirmed.':'Hand over the reward, then mark it redeemed.'}</p></div>${!value.redeemed?'<button class="ow-secondary" data-ow-action="redeem">Confirm redemption</button>':''}</div>`:''}`;
  }
  function openCustomer(value){
    stopCamera();modalCustomer=value;
    select('[data-ow-modal-content]').innerHTML=modalMarkup(value);
    const dialog=select('#owner-modal');if(!dialog.open)dialog.showModal();
  }
  function updateSelection(){
    if(pendingVisit||saveBusy)return;
    const count=select('[data-ow-form="stamps"]')?.querySelectorAll('input[name="categories"]:checked').length||0;
    const button=select('[data-ow-confirm]');if(button){button.disabled=count===0;button.innerHTML=`${count?`Okay, add ${count} ${count===1?'stamp':'stamps'}`:'Okay, add stamps'} ${ownerIcon('check')}`;}
  }
  async function saveStamps(form){
    if(saveBusy||!modalCustomer)return;
    if(!pendingVisit){
      const fields=new FormData(form),categories=fields.getAll('categories');
      if(!categories.length)return;
      pendingVisit={code:modalCustomer.code,categories,directOrder:fields.get('directOrder')==='on',requestId:uuid()};
      pendingVisits.set(modalCustomer.code,pendingVisit);
    }
    const payload=pendingVisit;saveBusy=true;
    const button=select('[data-ow-confirm]');button.disabled=true;button.textContent='Adding discoveries…';
    form.querySelectorAll('fieldset,input').forEach(el=>el.disabled=true);
    const errorEl=select('[data-ow-save-error]');errorEl.hidden=true;
    try{
      const result=await api('/api/owner/stamps',{method:'POST',body:payload});
      pendingVisits.delete(payload.code);pendingVisit=null;
      if(disposed)return;
      customer=result.customer;modalCustomer=null;
      const dialog=select('#owner-modal');if(dialog.open)dialog.close();
      showDashboard();
      const count=result.earned?.length??payload.categories.length;
      toast(`${count} ${count===1?'new discovery':'new discoveries'} stamped. Their passport is updated.`);
      select('[data-ow-action="camera"]')?.focus();
    }catch(error){
      if(disposed)return;
      const currentError=select('[data-ow-save-error]');
      currentError.textContent=`${errorText(error)} Retry to confirm the same purchase without adding it twice.`;currentError.hidden=false;
      button.disabled=false;button.innerHTML=`Retry confirmation ${ownerIcon('check')}`;
    }finally{saveBusy=false;}
  }
  async function redeem(){
    if(saveBusy||!modalCustomer||modalCustomer.redeemed)return;
    const current=modalCustomer;saveBusy=true;
    const button=select('[data-ow-action="redeem"]');button.disabled=true;button.textContent='Confirming…';
    try{
      const result=await api('/api/owner/redeem',{method:'POST',body:{code:current.code}});
      if(disposed)return;
      customer=result.customer;openCustomer(customer);toast('Reward marked as redeemed.');
    }catch(error){if(!disposed){const el=select('[data-ow-save-error]');el.textContent=errorText(error);el.hidden=false;button.disabled=false;button.textContent='Confirm redemption';}}
    finally{saveBusy=false;}
  }
  async function startCamera(){
    if(cameraStarting||scanner||lookupBusy)return;
    const errorEl=select('[data-ow-camera-error]');errorEl.hidden=true;
    cameraStarting=true;cameraController=new AbortController();
    const controller=cameraController,button=select('[data-ow-action="camera"]');
    button.disabled=true;button.textContent='Opening camera…';
    select('[data-ow-action="stop-camera"]').hidden=false;
    try{
      const video=select('[data-ow-video]');
      const active=await startQrScanner(video,raw=>{if(!disposed&&!lookupBusy)lookup(raw);},{signal:controller.signal});
      if(disposed||controller.signal.aborted){active.stop();return;}
      scanner=active;cameraStarting=false;
      select('[data-ow-camera]').classList.add('is-scanning');button.textContent='Scanner is on';
    }catch(error){
      if(disposed||controller.signal.aborted||error?.name==='AbortError')return;
      stopCamera();
      errorEl.textContent=`${errorText(error)} You can also paste the code below.`;errorEl.hidden=false;
      select('#ow-code')?.focus();
    }
  }
  function onDialogCancel(event){if(saveBusy)event.preventDefault();else stopCamera();}
  function closeCustomer(){if(saveBusy)return;select('#owner-modal')?.close();modalCustomer=null;pendingVisit=null;}
  async function onClick(event){
    const button=event.target.closest('[data-ow-action]');if(!button||!container.contains(button))return;
    event.preventDefault();
    switch(button.dataset.owAction){
      case'exit':if(!saveBusy){stopCamera();onExit();}break;
      case'logout':{
        if(saveBusy)return;stopCamera();button.disabled=true;
        try{await api('/api/owner/logout',{method:'POST',body:{}});if(!disposed)showAuth();}
        catch(error){if(!disposed){toast(errorText(error));button.disabled=false;}}
        break;
      }
      case'camera':startCamera();break;
      case'stop-camera':stopCamera();break;
      case'close-modal':closeCustomer();break;
      case'review':if(customer)lookup(customer.code);break;
      case'redeem':redeem();break;
    }
  }
  function onSubmit(event){
    const form=event.target.closest('[data-ow-form]');if(!form)return;event.preventDefault();
    if(form.dataset.owForm==='auth')authenticate(form);
    if(form.dataset.owForm==='lookup')lookup(new FormData(form).get('code'));
    if(form.dataset.owForm==='stamps')saveStamps(form);
  }
  function onVisibility(){if(document.hidden)stopCamera();}
  container.addEventListener('click',onClick);
  container.addEventListener('submit',onSubmit);
  container.addEventListener('change',updateSelection);
  document.addEventListener('visibilitychange',onVisibility);
  showLoading();
  (async()=>{
    try{
      const status=await api('/api/status');
      if(disposed)return;
      configured=Boolean(status.ownerConfigured);
      if(configured){
        try{await api('/api/owner/session');if(disposed)return;authenticated=true;}
        catch{authenticated=false;}
      }
      if(authenticated)showDashboard();else showAuth();
    }catch(error){
      if(disposed)return;
      lastError=errorText(error);
      shell(`<div class="ow-offline-error"><h2>The owner workspace couldn’t open.</h2><p>${ownerEscape(lastError)}</p><button class="ow-secondary" data-ow-action="exit">Back to customer passport ${ownerIcon('arrow')}</button></div>`);
    }
  })();
  return()=>{
    disposed=true;stopCamera();
    select('#owner-modal')?.close();
    container.removeEventListener('click',onClick);
    container.removeEventListener('submit',onSubmit);
    container.removeEventListener('change',updateSelection);
    document.removeEventListener('visibilitychange',onVisibility);
  };
}
