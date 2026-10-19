import {BOARD_CELLS,getBingoStatus} from './loyalty.js';
import {startQrScanner} from './qr.js';

const ownerEscape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ownerIcon=(name,cls='')=>`<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const ownerCustomerName=value=>value.name||[value.firstName,value.lastName].filter(Boolean).join(' ')||'Umami guest';
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
  throw new Error('That is not an Umami Bingo code. Scan the customer’s QR code or paste their 32-character code.');
}

export function mountOwner({container,api,onExit,toast=()=>{},offline=false}){
  let disposed=false,authenticated=false,bootBusy=false,customer=null,scanner=null,cameraController=null,cameraStarting=false,lookupBusy=false,authBusy=false,saveBusy=false,modalCustomer=null,pendingVisit=null,correctionMode=false,pendingCorrection=null,correctionStale=false;
  const pendingVisits=new Map(),pendingCorrections=new Map();
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
      const hint=select('[data-ow-camera-hint]');if(hint)hint.textContent='Camera is off. Tap Start scanner when you’re ready.';
    }
  }

  function header(){return `<div class="ow-heading"><div><div class="ow-kicker"><span></span>${statusLabel}</div><h1>A little scan.<br><em>A new discovery.</em></h1><p>Check a purchase. Stamp their card.<br>Keep the good taste going.</p></div><div class="ow-header-actions"><button class="ow-quiet" data-ow-action="exit">${ownerIcon('arrow')}Customer version</button>${authenticated&&!offline?`<button class="ow-signout" data-ow-action="logout">Sign out</button>`:''}</div></div>`;}
  function shell(contents){
    stopCamera();
    container.innerHTML=`<section class="ow-workspace">${header()}${contents}</section><dialog id="owner-modal" class="ow-dialog" aria-labelledby="ow-modal-title"><div data-ow-modal-content></div></dialog>`;
    const dialog=select('#owner-modal');
    dialog.addEventListener('cancel',onDialogCancel);
    dialog.addEventListener('close',()=>{
      if(disposed||dialog!==select('#owner-modal'))return;
      stopCamera();if(!saveBusy)modalCustomer=null;
    });
  }
  function showError(message){const el=select('[data-ow-error]');if(el){el.textContent=message;el.hidden=!message;}}
  function showLoading(){shell(`<div class="ow-loading" role="status"><span class="ow-loading-dot"></span>Opening your owner workspace…</div>`);}
  function showAuth(){
    authenticated=false;
    shell(`<div class="ow-auth-layout"><div class="ow-auth-card"><span class="ow-auth-seal">${ownerIcon('lock')}</span><div class="ow-kicker">FOR THE PEOPLE BEHIND THE COUNTER</div><h2>Owner sign-in.</h2><p>Enter your owner access code. Your camera will open so you can scan a customer’s QR code and stamp their purchases.</p><form data-ow-form="auth"><label for="ow-access-code">Owner access code</label><input id="ow-access-code" name="code" type="password" inputmode="numeric" autocomplete="current-password" maxlength="256" required placeholder="Enter your access code"><p class="ow-form-error" data-ow-error role="alert" hidden></p><button type="submit" class="ow-primary">Sign in & open scanner ${ownerIcon('arrow')}</button></form><span class="ow-auth-note">${ownerIcon('lock')}Keep this code private. Customers never need it.</span></div><aside class="ow-auth-story"><div class="ow-big-seal">${ownerIcon('passport')}</div><h2>From their screen<br>to a new stamp.</h2><ol><li><b>01</b><span>Sign in and allow camera access when your browser asks.</span></li><li><b>02</b><span>Scan the customer’s QR code and choose what they ordered.</span></li><li><b>03</b><span>Confirm their stamps. Your scanner opens for the next customer.</span></li></ol></aside></div>`);
  }
  function summaryMarkup(value){
    const bingo=getBingoStatus(value.stamps),name=ownerCustomerName(value),total=bingo.total||BOARD_CELLS.length;
    const rewardLabel=value.redeemed?`${value.redeemedDiscount?`${value.redeemedDiscount}% reward`:'Card reward'} redeemed · one reward per card`:bingo.blackout?'Blackout! 25% discount available':bingo.hasBingo?'Bingo! 10% discount available':'Complete a line for 10% or the full card for 25%.';
    return `<div class="ow-customer-summary"><div class="ow-customer-top"><div class="ow-customer-avatar">${ownerEscape(name.charAt(0).toUpperCase())}</div><div><div class="ow-kicker">LAST BINGO</div><h3>${ownerEscape(name)}</h3><span>${bingo.count} of ${total} purchase stamps</span></div><span class="ow-verified">${ownerIcon('check')}Updated</span></div><div class="ow-mini-stamps ow-bingo-summary">${BOARD_CELLS.map(c=>`<div class="${value.stamps?.[c.id]?'is-collected':''}" title="${ownerEscape(c.name)}: ${value.stamps?.[c.id]?'collected':'waiting'}">${ownerIcon(c.icon)}<span>${ownerEscape(c.name)}</span>${value.stamps?.[c.id]?'<b aria-label="Collected">✓</b>':''}</div>`).join('')}</div><div class="ow-summary-bottom"><span>${ownerEscape(rewardLabel)}</span><button class="ow-quiet" data-ow-action="review">Review bingo ${ownerIcon('arrow')}</button></div></div>`;
  }
  function showDashboard(){
    authenticated=true;
    shell(`${offline?'<div class="ow-demo-note">Offline demo: scan and stamp the customer bingo saved in this browser. To use separate phones, run the hosted app and share its secure website address.</div>':''}<div class="ow-dashboard"><section class="ow-scan-card"><div class="ow-card-heading"><div><div class="ow-kicker">ONE CUSTOMER. THEIR OWN BINGO.</div><h2>Ready when they are.</h2></div><span class="ow-step-tag">01 → 02 → 03</span></div><div class="ow-camera" data-ow-camera><video data-ow-video playsinline muted aria-label="Live camera QR scanner"></video><div class="ow-camera-idle"><div class="ow-scan-art">${ownerScanIcon}</div><h3>Point. Scan. Stamp.</h3><p>Ask the customer to open their bingo<br>and show you their QR code.</p></div><div class="ow-viewfinder" aria-hidden="true"><i></i><i></i><i></i><i></i></div><div class="ow-scanning-label">Looking for an Umami Bingo code…</div></div><div class="ow-camera-actions"><button class="ow-primary" data-ow-action="camera">${ownerScanIcon}Start scanner</button><button class="ow-quiet" data-ow-action="stop-camera" hidden>Stop camera</button><span data-ow-camera-hint>Allow camera access when your browser asks.</span></div><p class="ow-form-error" data-ow-camera-error role="alert" hidden></p><div class="ow-manual-divider"><span>or enter their code</span></div><form data-ow-form="lookup" class="ow-lookup-form"><label for="ow-code">CUSTOMER BINGO CODE</label><div><input id="ow-code" name="code" type="text" spellcheck="false" autocomplete="off" autocapitalize="characters" required placeholder="Paste their code or QR link" aria-describedby="ow-code-help"><button class="ow-secondary" type="submit">Look up bingo ${ownerIcon('arrow')}</button></div><small id="ow-code-help">Find the code below the QR on the customer’s screen.</small><p class="ow-form-error" data-ow-error role="alert" hidden></p></form></section><aside class="ow-how-card"><div class="ow-kicker">GOOD TASTE. A SIMPLE ROUTINE.</div><h2>Three little steps.</h2><ol><li><span>1</span><div><h3>Find their bingo.</h3><p>Scan the customer’s personal QR code, or enter their bingo code.</p></div></li><li><span>2</span><div><h3>Pick their discoveries.</h3><p>Choose every category they purchased. More than one? Tick them all.</p></div></li><li><span>3</span><div><h3>A little “okay”.</h3><p>Confirm the purchase. New stamps appear on their bingo automatically.</p></div></li></ol><div class="ow-how-note">${ownerIcon('check')}Already collected stamps stay marked. Each category counts once.</div></aside></div><section data-ow-last>${customer?summaryMarkup(customer):'<div class="ow-empty-recent">'+ownerIcon('passport')+'<span>Your first scan is waiting. Their next favourite is, too.</span></div>'}</section>`);
    if(!document.hidden)startCamera();
  }
  async function authenticate(form){
    if(authBusy)return;authBusy=true;
    const button=form.querySelector('button');button.disabled=true;showError('');
    try{
      await api('/api/owner/login',{method:'POST',body:{code:String(new FormData(form).get('code')||'').trim()}});
      if(disposed)return;
      showDashboard();
    }catch(error){
      if(!disposed){
        showError(error?.status===401?'That owner access code wasn’t accepted. Check the code and try again.':errorText(error));
        form.querySelector('input')?.focus();
      }
    }
    finally{authBusy=false;if(button.isConnected)button.disabled=false;}
  }
  async function lookup(value){
    if(lookupBusy)return;
    stopCamera();showError('');
    let code;try{code=ownerReadCode(value);}catch(error){showError(errorText(error));return;}
    lookupBusy=true;
    const button=select('[data-ow-form="lookup"] button');if(button){button.disabled=true;button.textContent='Finding bingo…';}
    try{
      const result=await api(`/api/owner/customer?code=${encodeURIComponent(code)}`);
      if(disposed)return;
      customer=result.customer;openCustomer(customer);
    }catch(error){
      if(disposed)return;
      showError(`${errorText(error)} Keep the customer’s QR code on screen and try again, or paste their bingo code below.`);
      if(error?.status===401){authenticated=false;showAuth();showError('Please sign in again to scan bingo cards.');}
    }finally{lookupBusy=false;if(button?.isConnected){button.disabled=false;button.innerHTML=`Look up bingo ${ownerIcon('arrow')}`;}}
  }
  function categoryGridMarkup(value,{correction=false,locked=false}={}){
    return `<fieldset class="ow-category-grid ow-bingo-options ${correction?'ow-correction-grid':''}" ${locked?'disabled':''}><legend class="ow-sr-only">${correction?'Saved stamps to keep':'Categories purchased'}</legend>${BOARD_CELLS.map(c=>{
      const collected=Boolean(value.stamps?.[c.id]);
      const selected=correction?collected&&!pendingCorrection?.categories.includes(c.id):Boolean(pendingVisit?.categories.includes(c.id));
      const disabled=correction?!collected:collected;
      const detail=correction?collected?'Saved stamp':'Not stamped':collected?'Already collected':c.description;
      return `<label class="ow-category-option ${collected?'is-collected':''}"><input type="checkbox" name="categories" value="${c.id}" ${disabled?'disabled':''} ${selected?'checked':''}><span class="ow-option-icon">${ownerIcon(c.icon)}</span><span class="ow-option-copy"><b>${ownerEscape(c.name)}</b><small data-ow-category-note>${ownerEscape(detail)}</small></span><span class="ow-option-tick" aria-hidden="true">${collected?'✓':''}</span></label>`;
    }).join('')}</fieldset>`;
  }
  function correctionMarkup(value){
    const locked=Boolean(pendingCorrection);
    return `<div class="ow-correction-banner"><div><b>Correct a mistake</b><p>Untick any saved stamps added by mistake. Nothing changes until you confirm.</p></div><button class="ow-quiet" data-ow-action="purchase-mode" ${locked?'disabled':''}>Back to purchases</button></div><form data-ow-form="corrections">${categoryGridMarkup(value,{correction:true,locked})}<p class="ow-modal-error" data-ow-correction-error role="alert" ${locked?'':'hidden'}>${locked?'This correction has an unconfirmed save. Retry to check the same removal without affecting any later stamps.':''}</p><button class="ow-primary ow-full ow-remove-button" type="submit" data-ow-remove ${locked?'':'disabled'}>${locked?'Retry removal':'Remove stamps'} ${ownerIcon('close')}</button><section class="ow-correction-confirm" data-ow-correction-confirm hidden><h3>Remove mistaken stamps?</h3><p><span data-ow-removal-count></span> The customer will see this update and discount eligibility will be recalculated. A reward already redeemed stays used.</p><div><button class="ow-quiet" type="button" data-ow-action="cancel-removal">Keep editing</button><button class="ow-primary" type="button" data-ow-action="confirm-removal">Confirm removal ${ownerIcon('check')}</button></div></section><button class="ow-secondary ow-full" type="button" data-ow-action="reload-bingo" hidden>Reload bingo ${ownerIcon('arrow')}</button><p class="ow-save-note">Only saved stamps can be removed here. Purchases and reward redemption history are kept.</p></form>`;
  }
  function modalMarkup(value,notice=''){
    const bingo=getBingoStatus(value.stamps),name=ownerCustomerName(value),total=bingo.total||BOARD_CELLS.length;
    const locked=Boolean(pendingVisit);
    const normal=`<div class="ow-mode-bar"><span>Verify this purchase</span><button class="ow-quiet" data-ow-action="correct-stamps" ${locked||!bingo.count?'disabled':''}>Correct stamps</button></div><p class="ow-modal-intro">Select every category in this purchase.<br>Only choose food the customer purchased.</p><form data-ow-form="stamps">${categoryGridMarkup(value,{locked})}<label class="ow-direct-option"><input type="checkbox" name="directOrder" ${pendingVisit?.directOrder?'checked':''} ${locked?'disabled':''}>${ownerIcon('bag')}<span><b>They ordered directly with Umami</b><small>Add a direct-order badge for this visit.</small></span></label><p class="ow-modal-error" data-ow-save-error role="alert" ${locked?'':'hidden'}>${locked?'This visit has an unconfirmed save. Retry to check the same purchase without adding it twice.':''}</p><button class="ow-primary ow-full" type="submit" data-ow-confirm ${locked?'':'disabled'}>${locked?'Retry confirmation':'Okay, add stamps'} ${ownerIcon('check')}</button><p class="ow-save-note">${bingo.blackout?`All ${total} purchase categories are collected. Their card is a blackout.`:'Only select categories from a purchase you have checked.'}</p></form>${rewardMarkup(value,bingo)}`;
    return `<div class="ow-modal-header"><div class="ow-kicker">${correctionMode?'CHECK THE SAVED STAMPS':'VERIFY THE PURCHASE'}</div><button class="ow-modal-close" data-ow-action="close-modal" aria-label="Close bingo">${ownerIcon('close')}</button></div><h2 id="ow-modal-title">${correctionMode?'Correct their bingo.':'What did they get?'}</h2><div class="ow-modal-person"><span class="ow-customer-avatar">${ownerEscape(name.charAt(0).toUpperCase())}</span><div><b>${ownerEscape(name)}</b><span>${bingo.count} of ${total} purchase stamps · ${ownerEscape(value.code.slice(0,4))}…${ownerEscape(value.code.slice(-4))}</span></div></div>${notice?`<p class="ow-correction-success" role="status">${ownerEscape(notice)}</p>`:''}${correctionMode?correctionMarkup(value):normal}`;
  }
  function rewardMarkup(value,bingo){
    if(!bingo.hasBingo&&!value.redeemed)return '<p class="ow-bingo-terms">Any horizontal, vertical or diagonal line earns 10%. A full card earns 25%. One reward per card; discounts cannot be combined.</p>';
    const redeemed=value.redeemed,discount=bingo.discount;
    const title=redeemed?`${value.redeemedDiscount?`${value.redeemedDiscount}% reward`:'Card reward'} already redeemed`:bingo.blackout?'Blackout! 25% discount unlocked':'Bingo! 10% discount unlocked';
    return `<section class="ow-redeem-box">${ownerIcon('gift')}<div><b>${ownerEscape(title)}</b><p>${redeemed?'This card’s one reward has been used. Further stamps do not unlock another discount.':bingo.blackout?`All ${bingo.total||BOARD_CELLS.length} purchase stamps collected.`:'A complete horizontal, vertical or diagonal line.'}</p></div>${!redeemed?`<button class="ow-secondary" data-ow-action="redeem" ${pendingVisit?'disabled':''}>Use ${discount}% reward</button><div class="ow-redemption-confirm" data-ow-redeem-confirm hidden><h3>Use their one reward now?</h3><p>${discount===10?'Redeeming 10% uses this card’s only reward. They can keep collecting instead to reach a full card worth 25%.':'Confirm the 25% discount on this purchase. This uses the card’s only reward.'} This discount cannot be combined with another offer.</p><div><button class="ow-quiet" data-ow-action="cancel-redeem">${discount===10?'Keep collecting':'Cancel'}</button><button class="ow-primary" data-ow-action="confirm-redeem">Confirm ${discount}% discount ${ownerIcon('check')}</button></div></div>`:''}</section>`;
  }
  function openCustomer(value,{correction=false,notice=''}={}){
    stopCamera();modalCustomer=value;correctionStale=false;
    pendingVisit=pendingVisits.get(value.code)||null;
    pendingCorrection=pendingCorrections.get(value.code)||null;
    correctionMode=!pendingVisit&&(correction||Boolean(pendingCorrection));
    select('[data-ow-modal-content]').innerHTML=modalMarkup(value,notice);
    const dialog=select('#owner-modal');if(!dialog.open)dialog.showModal();
  }
  function updateSelection(){
    if(correctionMode){
      if(pendingCorrection||correctionStale||saveBusy)return;
      const categories=correctionCategories(),button=select('[data-ow-remove]');
      if(button){button.disabled=categories.length===0;button.hidden=false;button.textContent=categories.length?`Remove ${categories.length} ${categories.length===1?'stamp':'stamps'}`:'Remove stamps';}
      select('[data-ow-correction-confirm]').hidden=true;
      select('[data-ow-form="corrections"]').querySelectorAll('label.is-collected').forEach(label=>{label.querySelector('[data-ow-category-note]').textContent=label.querySelector('input').checked?'Saved stamp':'Will be removed';});
      return;
    }
    if(pendingVisit||saveBusy)return;
    const count=select('[data-ow-form="stamps"]')?.querySelectorAll('input[name="categories"]:checked').length||0;
    const button=select('[data-ow-confirm]');if(button){button.disabled=count===0;button.innerHTML=`${count?`Okay, add ${count} ${count===1?'stamp':'stamps'}`:'Okay, add stamps'} ${ownerIcon('check')}`;}
  }
  async function saveStamps(form){
    if(saveBusy||!modalCustomer||correctionMode||pendingCorrection)return;
    if(!pendingVisit){
      const fields=new FormData(form),categories=fields.getAll('categories');
      if(!categories.length)return;
      pendingVisit={code:modalCustomer.code,categories,directOrder:fields.get('directOrder')==='on',requestId:uuid()};
      pendingVisits.set(modalCustomer.code,pendingVisit);
    }
    const payload=pendingVisit;saveBusy=true;
    const button=select('[data-ow-confirm]');button.disabled=true;button.textContent='Adding discoveries…';
    form.querySelectorAll('fieldset,input').forEach(el=>el.disabled=true);
    const correction=select('[data-ow-action="correct-stamps"]');if(correction)correction.disabled=true;
    const reward=select('[data-ow-action="redeem"]');if(reward)reward.disabled=true;
    const errorEl=select('[data-ow-save-error]');errorEl.hidden=true;
    try{
      const result=await api('/api/owner/stamps',{method:'POST',body:payload});
      pendingVisits.delete(payload.code);pendingVisit=null;
      if(disposed)return;
      customer=result.customer;modalCustomer=null;
      const dialog=select('#owner-modal');if(dialog.open)dialog.close();
      showDashboard();
      const count=result.earned?.length??payload.categories.length;
      toast(`${count} ${count===1?'new discovery':'new discoveries'} stamped. Their bingo is updated.`);
      select('[data-ow-action="camera"]')?.focus();
    }catch(error){
      if(disposed)return;
      const currentError=select('[data-ow-save-error]');
      currentError.textContent=`${errorText(error)} Retry to confirm the same purchase without adding it twice.`;currentError.hidden=false;
      button.disabled=false;button.innerHTML=`Retry confirmation ${ownerIcon('check')}`;
    }finally{saveBusy=false;}
  }
  function correctionCategories(){
    const form=select('[data-ow-form="corrections"]');
    if(!form||!modalCustomer)return [];
    return BOARD_CELLS.filter(category=>modalCustomer.stamps?.[category.id]&&!form.querySelector(`input[value="${category.id}"]`).checked).map(category=>category.id);
  }
  function enterCorrection(){
    if(saveBusy||pendingVisit||!modalCustomer||!getBingoStatus(modalCustomer.stamps).count)return;
    if(select('[data-ow-form="stamps"] input[name="categories"]:checked')){
      const error=select('[data-ow-save-error]');error.textContent='Confirm or untick the current purchase selections before correcting saved stamps.';error.hidden=false;
      return;
    }
    openCustomer(modalCustomer,{correction:true});
  }
  function showCorrectionConfirm(){
    if(saveBusy||correctionStale||!correctionMode||!modalCustomer||pendingVisit)return;
    if(pendingCorrection){saveCorrection();return;}
    const categories=correctionCategories();if(!categories.length)return;
    select('[data-ow-removal-count]').textContent=`${categories.length} saved ${categories.length===1?'stamp will':'stamps will'} be removed.`;
    select('[data-ow-correction-confirm]').hidden=false;
    select('[data-ow-remove]').hidden=true;
    select('[data-ow-action="cancel-removal"]')?.focus();
  }
  function cancelCorrectionConfirm(){
    if(saveBusy||pendingCorrection||correctionStale)return;
    select('[data-ow-correction-confirm]').hidden=true;
    select('[data-ow-remove]').hidden=false;
    select('[data-ow-remove]')?.focus();
  }
  async function saveCorrection(){
    if(saveBusy||correctionStale||!correctionMode||!modalCustomer||pendingVisit)return;
    if(!pendingCorrection){
      const categories=correctionCategories();if(!categories.length)return;
      pendingCorrection={code:modalCustomer.code,categories,requestId:uuid(),expectedStamps:Object.fromEntries(categories.map(id=>[id,modalCustomer.stamps[id]]))};
      pendingCorrections.set(modalCustomer.code,pendingCorrection);
    }
    const payload=pendingCorrection,form=select('[data-ow-form="corrections"]');
    saveBusy=true;
    form.querySelectorAll('fieldset,input,button').forEach(element=>element.disabled=true);
    select('[data-ow-action="purchase-mode"]').disabled=true;
    const error=select('[data-ow-correction-error]');error.hidden=true;
    const confirm=select('[data-ow-action="confirm-removal"]');confirm.textContent='Removing stamps…';
    try{
      const result=await api('/api/owner/stamps/remove',{method:'POST',body:payload});
      pendingCorrections.delete(payload.code);pendingCorrection=null;
      if(disposed)return;
      customer=result.customer;
      select('[data-ow-last]').innerHTML=summaryMarkup(customer);
      const count=result.removed?.length??payload.categories.length;
      openCustomer(customer,{correction:true,notice:`${count} mistaken ${count===1?'stamp removed':'stamps removed'}. The customer’s bingo is updated.`});
      toast(`${count} ${count===1?'stamp':'stamps'} removed. Reward redemption history is kept.`);
    }catch(failure){
      if(disposed)return;
      select('[data-ow-correction-confirm]').hidden=true;
      const button=select('[data-ow-remove]');button.hidden=false;
      if(failure?.status===409){
        pendingCorrections.delete(payload.code);pendingCorrection=null;correctionStale=true;
        error.textContent='This bingo changed since you opened it. No newer stamp was removed. Reload the bingo and review the saved stamps before correcting them.';
        button.textContent='Reload needed';
        const reload=select('[data-ow-action="reload-bingo"]');reload.hidden=false;reload.disabled=false;
      }else{
        error.textContent=`${errorText(failure)} Retry the same correction to confirm its result without removing any later stamps.`;
        button.disabled=false;button.textContent='Retry removal';
      }
      error.hidden=false;
    }finally{saveBusy=false;}
  }
  async function reloadCorrection(){
    if(saveBusy||lookupBusy||!modalCustomer||pendingCorrection)return;
    const code=modalCustomer.code,button=select('[data-ow-action="reload-bingo"]'),dialog=select('#owner-modal');
    lookupBusy=true;button.disabled=true;button.textContent='Reloading bingo…';stopCamera();
    try{
      const result=await api(`/api/owner/customer?code=${encodeURIComponent(code)}`);
      if(disposed||!dialog.open||modalCustomer?.code!==code)return;
      customer=result.customer;select('[data-ow-last]').innerHTML=summaryMarkup(customer);
      openCustomer(customer,{correction:true,notice:'Bingo reloaded. Review the saved stamps before making a correction.'});
    }catch(failure){
      if(!disposed){const error=select('[data-ow-correction-error]');error.textContent=errorText(failure);error.hidden=false;button.disabled=false;button.textContent='Reload bingo';}
    }finally{lookupBusy=false;}
  }
  function showRedemption(){
    if(saveBusy||pendingVisit||pendingCorrection||correctionMode||!modalCustomer||modalCustomer.redeemed||!getBingoStatus(modalCustomer.stamps).hasBingo)return;
    if(select('[data-ow-form="stamps"] input[name="categories"]:checked')){
      const error=select('[data-ow-save-error]');error.textContent='Confirm the selected purchase stamps first, then review this bingo to use its reward.';error.hidden=false;
      return;
    }
    const prompt=select('[data-ow-redeem-confirm]');if(!prompt)return;
    prompt.hidden=false;select('[data-ow-action="redeem"]').hidden=true;
    prompt.querySelector('[data-ow-action="cancel-redeem"]')?.focus();
  }
  function cancelRedemption(){
    if(saveBusy)return;
    const prompt=select('[data-ow-redeem-confirm]');if(prompt)prompt.hidden=true;
    const button=select('[data-ow-action="redeem"]');if(button){button.hidden=false;button.focus();}
  }
  async function redeem(){
    if(saveBusy||pendingVisit||pendingCorrection||correctionMode||!modalCustomer||modalCustomer.redeemed||!getBingoStatus(modalCustomer.stamps).hasBingo)return;
    const current=modalCustomer;saveBusy=true;
    const button=select('[data-ow-action="confirm-redeem"]'),discount=getBingoStatus(current.stamps).discount;button.disabled=true;button.textContent='Confirming…';
    try{
      const result=await api('/api/owner/redeem',{method:'POST',body:{code:current.code}});
      if(disposed)return;
      customer=result.customer;openCustomer(customer);toast(`${customer.redeemedDiscount||discount}% discount marked as redeemed.`);
    }catch(error){if(!disposed){const el=select('[data-ow-save-error]');el.textContent=errorText(error);el.hidden=false;button.disabled=false;button.textContent=`Confirm ${discount}% discount`;}}
    finally{saveBusy=false;}
  }
  async function startCamera(){
    if(disposed||!authenticated||document.hidden||cameraStarting||scanner||lookupBusy||select('#owner-modal')?.open)return;
    const errorEl=select('[data-ow-camera-error]');if(!errorEl)return;errorEl.hidden=true;
    cameraStarting=true;cameraController=new AbortController();
    const controller=cameraController,button=select('[data-ow-action="camera"]');
    button.disabled=true;button.textContent='Opening camera…';
    const hint=select('[data-ow-camera-hint]');if(hint)hint.textContent='Allow camera access when your browser asks.';
    select('[data-ow-action="stop-camera"]').hidden=false;
    try{
      const video=select('[data-ow-video]');
      const active=await startQrScanner(video,raw=>{if(!disposed&&!lookupBusy)lookup(raw);},{signal:controller.signal});
      if(disposed||controller.signal.aborted){active.stop();return;}
      scanner=active;cameraStarting=false;
      select('[data-ow-camera]').classList.add('is-scanning');button.textContent='Scanner is on';
      if(hint)hint.textContent='Hold the customer’s QR code inside the frame.';
    }catch(error){
      if(disposed||controller.signal.aborted||error?.name==='AbortError')return;
      stopCamera();
      errorEl.textContent=`${errorText(error)} Tap Start scanner to try again and allow camera access, or paste the customer’s bingo code below.`;errorEl.hidden=false;
    }
  }
  function onDialogCancel(event){if(saveBusy)event.preventDefault();else stopCamera();}
  function closeCustomer(){if(saveBusy)return;select('#owner-modal')?.close();modalCustomer=null;pendingVisit=null;pendingCorrection=null;correctionMode=false;correctionStale=false;}
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
      case'correct-stamps':enterCorrection();break;
      case'purchase-mode':if(!saveBusy&&!pendingCorrection&&!correctionStale&&modalCustomer)openCustomer(modalCustomer);break;
      case'cancel-removal':cancelCorrectionConfirm();break;
      case'confirm-removal':saveCorrection();break;
      case'reload-bingo':reloadCorrection();break;
      case'redeem':showRedemption();break;
      case'cancel-redeem':cancelRedemption();break;
      case'confirm-redeem':redeem();break;
      case'retry-owner':initializeOwner();break;
    }
  }
  function onSubmit(event){
    const form=event.target.closest('[data-ow-form]');if(!form)return;event.preventDefault();
    if(form.dataset.owForm==='auth')authenticate(form);
    if(form.dataset.owForm==='lookup')lookup(new FormData(form).get('code'));
    if(form.dataset.owForm==='stamps')saveStamps(form);
    if(form.dataset.owForm==='corrections')showCorrectionConfirm();
  }
  function onVisibility(){if(document.hidden)stopCamera();}
  container.addEventListener('click',onClick);
  container.addEventListener('submit',onSubmit);
  container.addEventListener('change',updateSelection);
  document.addEventListener('visibilitychange',onVisibility);
  async function initializeOwner(){
    if(disposed||bootBusy)return;
    bootBusy=true;authenticated=false;showLoading();
    try{
      await api('/api/status');
      if(disposed)return;
      try{await api('/api/owner/session');if(disposed)return;authenticated=true;}
      catch(error){if(error?.status!==401)throw error;authenticated=false;}
      if(authenticated)showDashboard();else showAuth();
    }catch(error){
      if(disposed)return;
      shell(`<div class="ow-offline-error"><h2>Owner sign-in needs a connection.</h2><p>${ownerEscape(errorText(error))}</p><p>The owner scanner needs the account service. Check your connection and try again. If this is an older Netlify upload, redeploy the complete app, including its Netlify Functions.</p><div class="ow-service-actions"><button class="ow-primary" data-ow-action="retry-owner">Try again ${ownerIcon('arrow')}</button><button class="ow-quiet" data-ow-action="exit">Back to customer bingo</button></div></div>`);
    }finally{bootBusy=false;}
  }
  initializeOwner();
  return()=>{
    disposed=true;stopCamera();
    select('#owner-modal')?.close();
    container.removeEventListener('click',onClick);
    container.removeEventListener('submit',onSubmit);
    container.removeEventListener('change',updateSelection);
    document.removeEventListener('visibilitychange',onVisibility);
  };
}
