import {BOARD_CELLS,getBingoStatus,getRewardStatus} from './loyalty.js';
import {startQrScanner} from './qr.js';
import {createRequestId} from './request-id.js';

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
  let searchQuery='',searchResults=[],searchBusy=false,searchPerformed=false,searchError='',searchController=null,searchGeneration=0,ownerSessionGeneration=0,openingSearchCode='',lastScanPayload='',lastScanAttempt=0;
  let pendingRedemption=null,selectedRewardId=null,redemptionNeedsReload=false,redemptionError='',rewardUsedThisReview=false;
  let resetReview=false,pendingReset=null,resetNeedsReload=false,resetError='';
  const pendingVisits=new Map(),pendingCorrections=new Map(),pendingRedemptions=new Map(),pendingResets=new Map();
  const select=selector=>container.querySelector(selector);
  const statusLabel=offline?'Offline demo · same browser only':'OWNER WORKSPACE';
  const errorText=error=>error?.message||'Something went wrong. Please try again.';

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

  function header(){return `<div class="ow-heading"><div><div class="ow-kicker"><span></span>${statusLabel}</div><h1>A little scan.<br><em>A new discovery.</em></h1><p>Check a purchase. Stamp their card.<br>Keep the good taste going.</p></div><div class="ow-header-actions"><button class="ow-quiet" data-ow-action="exit">${ownerIcon('arrow')}Customer version</button>${authenticated?'<button class="ow-quiet" data-ow-action="focus-search">Find a customer</button>':''}${authenticated&&!offline?`<button class="ow-signout" data-ow-action="logout">Sign out</button>`:''}</div></div>`;}
  function shell(contents){
    stopCamera();
    container.innerHTML=`<section class="ow-workspace">${header()}${contents}</section><dialog id="owner-modal" class="ow-dialog" aria-labelledby="ow-modal-title"><div data-ow-modal-content></div></dialog>`;
    const dialog=select('#owner-modal');
    dialog.addEventListener('cancel',onDialogCancel);
    dialog.addEventListener('close',()=>{
      if(disposed||dialog!==select('#owner-modal'))return;
      stopCamera();if(!saveBusy){modalCustomer=null;clearRewardReview();clearResetReview();}
    });
  }
  function showError(message){const el=select('[data-ow-error]');if(el){el.textContent=message;el.hidden=!message;}}
  function showLoading(){shell(`<div class="ow-loading" role="status"><span class="ow-loading-dot"></span>Opening your owner workspace…</div>`);}
  function showAuth(){
    authenticated=false;ownerSessionGeneration++;clearSearch();
    shell(`<div class="ow-auth-layout"><div class="ow-auth-card"><span class="ow-auth-seal">${ownerIcon('lock')}</span><div class="ow-kicker">FOR THE PEOPLE BEHIND THE COUNTER</div><h2>Owner sign-in.</h2><p>Enter your owner access code. Your camera will open so you can scan a customer’s QR code and stamp their purchases.</p><form data-ow-form="auth"><label for="ow-access-code">Owner access code</label><input id="ow-access-code" name="code" type="password" inputmode="numeric" autocomplete="current-password" maxlength="256" required placeholder="Enter your access code"><p class="ow-form-error" data-ow-error role="alert" hidden></p><button type="submit" class="ow-primary">Sign in & open scanner ${ownerIcon('arrow')}</button></form><span class="ow-auth-note">${ownerIcon('lock')}Keep this code private. Customers never need it.</span></div><aside class="ow-auth-story"><div class="ow-big-seal">${ownerIcon('passport')}</div><h2>From their screen<br>to a new stamp.</h2><ol><li><b>01</b><span>Sign in and allow camera access when your browser asks.</span></li><li><b>02</b><span>Scan the customer’s QR code and choose what they ordered.</span></li><li><b>03</b><span>Confirm their stamps. Your scanner opens for the next customer.</span></li></ol></aside></div>`);
  }
  function summaryMarkup(value){
    const bingo=getBingoStatus(value.stamps),name=ownerCustomerName(value),total=bingo.total||BOARD_CELLS.length;
    const rewards=getRewardStatus(value),lineCount=rewards.availableRewards.filter(reward=>reward.discount===10).length;
    const availability=rewards.legacyUnknown?'Previous reward recorded':`${lineCount} unused 10% line ${lineCount===1?'coupon':'coupons'} available${rewards.availableRewards.some(reward=>reward.id==='blackout')?' · 25% full-card coupon available':''}`;
    const rewardLabel=`${availability} · ${rewards.count} ${rewards.count===1?'discount used':'discounts used'}`;
    return `<div class="ow-customer-summary"><div class="ow-customer-top"><div class="ow-customer-avatar">${ownerEscape(name.charAt(0).toUpperCase())}</div><div><div class="ow-kicker">LAST BINGO</div><h3>${ownerEscape(name)}</h3><span>${bingo.count} of ${total} purchase stamps</span></div><span class="ow-verified">${ownerIcon('check')}Updated</span></div><div class="ow-mini-stamps ow-bingo-summary">${BOARD_CELLS.map(c=>`<div class="${value.stamps?.[c.id]?'is-collected':''}" title="${ownerEscape(c.name)}: ${value.stamps?.[c.id]?'collected':'waiting'}">${ownerIcon(c.icon)}<span>${ownerEscape(c.name)}</span>${value.stamps?.[c.id]?'<b aria-label="Collected">✓</b>':''}</div>`).join('')}</div><div class="ow-summary-bottom"><span>${ownerEscape(rewardLabel)}</span><button class="ow-quiet" data-ow-action="review">Review bingo ${ownerIcon('arrow')}</button></div></div>`;
  }
  function searchMarkup(){
    return `<section class="ow-search-card" aria-labelledby="ow-search-heading"><div class="ow-search-heading"><div><div class="ow-kicker">ANOTHER WAY TO FIND THEIR CARD</div><h2 id="ow-search-heading">Find a customer.</h2></div><button class="ow-quiet" data-ow-action="clear-search" data-ow-clear-search hidden>Clear search</button></div><form data-ow-form="search" class="ow-search-form"><label for="ow-customer-query">Customer name or email</label><div><input id="ow-customer-query" name="query" type="search" minlength="2" maxlength="120" autocomplete="off" spellcheck="false" required placeholder="Start with a name or email" aria-describedby="ow-search-status" data-ow-search-input value="${ownerEscape(searchQuery)}"><button type="submit" class="ow-secondary">Search ${ownerIcon('arrow')}</button></div></form><p class="ow-search-status" id="ow-search-status" data-ow-search-status role="status" aria-live="polite"></p><ul class="ow-search-results" data-ow-search-results aria-label="Matching customers" hidden></ul></section>`;
  }
  function renderSearch(){
    const section=select('.ow-search-card');if(!section)return;
    section.setAttribute('aria-busy',String(searchBusy));
    const status=select('[data-ow-search-status]');
    status.classList.toggle('is-error',Boolean(searchError));
    status.textContent=searchBusy?'Searching customer accounts…':searchError||(!searchPerformed?'Enter at least two characters. Customer accounts appear after you search.':searchResults.length?`${searchResults.length} ${searchResults.length===1?'customer found':'customers found'}.${searchResults.length>=20?' Refine the name or email if you need a closer match.':''}`:`No customers found for “${searchQuery}”. Try another name or email.`);
    const list=select('[data-ow-search-results]');list.hidden=searchResults.length===0||searchBusy;
    list.innerHTML=searchResults.map((entry,index)=>{
      const name=ownerCustomerName(entry),email=typeof entry.email==='string'?entry.email:'';
      return `<li><span class="ow-search-avatar" aria-hidden="true">${ownerEscape(name.charAt(0).toUpperCase())}</span><div class="ow-search-person"><h3>${ownerEscape(name)}</h3>${email?`<p>${ownerEscape(email)}</p>`:'<p>Email not added</p>'}</div><button type="button" class="ow-secondary" data-ow-action="open-search" data-ow-result-index="${index}" ${lookupBusy?'disabled':''} aria-label="Open bingo for ${ownerEscape(name)}${email?', '+ownerEscape(email):''}">${openingSearchCode===entry.code?'Opening…':'Open bingo'}${ownerIcon('arrow')}</button></li>`;
    }).join('');
    const button=select('[data-ow-form="search"] button');button.disabled=searchBusy;button.innerHTML=searchBusy?'Searching…':`Search ${ownerIcon('arrow')}`;
    select('[data-ow-clear-search]').hidden=!(searchQuery||searchResults.length||searchBusy||searchError);
  }
  function clearSearch(){
    searchController?.abort();searchController=null;searchGeneration++;
    searchQuery='';searchResults=[];searchBusy=false;searchPerformed=false;searchError='';openingSearchCode='';
    const input=select('[data-ow-search-input]');if(input)input.value='';
    renderSearch();
  }
  function onSearchInput(event){
    if(!event.target.matches('[data-ow-search-input]'))return;
    const value=event.target.value;if(value===searchQuery)return;
    searchController?.abort();searchController=null;searchGeneration++;
    searchQuery=value;searchResults=[];searchBusy=false;searchPerformed=false;searchError='';
    renderSearch();
  }
  async function searchCustomers(form){
    if(disposed||!authenticated)return;
    const query=String(new FormData(form).get('query')||'').trim();
    searchController?.abort();
    const generation=++searchGeneration;
    searchQuery=query;searchResults=[];searchPerformed=true;searchError='';
    if(query.length<2||query.length>120){searchBusy=false;searchError='Enter between 2 and 120 characters of the customer’s name or email.';renderSearch();return;}
    searchController=new AbortController();const controller=searchController;
    searchBusy=true;renderSearch();
    try{
      const result=await api(`/api/owner/customers?q=${encodeURIComponent(query)}`,{signal:controller.signal});
      if(disposed||controller.signal.aborted||generation!==searchGeneration)return;
      searchResults=Array.isArray(result.customers)?result.customers.slice(0,20):[];
    }catch(failure){
      if(disposed||controller.signal.aborted||generation!==searchGeneration)return;
      if(failure?.status===401){showAuth();showError('Please sign in again to search customer accounts.');return;}
      searchError=`${errorText(failure)} Try searching again.`;
    }finally{
      if(!disposed&&generation===searchGeneration){searchBusy=false;searchController=null;renderSearch();}
    }
  }
  function showDashboard(){
    authenticated=true;
    shell(`${offline?'<div class="ow-demo-note">Offline demo: scan and stamp the customer bingo saved in this browser. To use separate phones, run the hosted app and share its secure website address.</div>':''}<div class="ow-dashboard"><section class="ow-scan-card"><div class="ow-card-heading"><div><div class="ow-kicker">ONE CUSTOMER. THEIR OWN BINGO.</div><h2>Ready when they are.</h2></div><span class="ow-step-tag">01 → 02 → 03</span></div><div class="ow-camera" data-ow-camera><video data-ow-video playsinline muted aria-label="Live camera QR scanner"></video><div class="ow-camera-idle"><div class="ow-scan-art">${ownerScanIcon}</div><h3>Point. Scan. Stamp.</h3><p>Ask the customer to open their bingo<br>and show you their QR code.</p></div><div class="ow-viewfinder" aria-hidden="true"><i></i><i></i><i></i><i></i></div><div class="ow-scanning-label">Looking for an Umami Bingo code…</div></div><div class="ow-camera-actions"><button class="ow-primary" data-ow-action="camera">${ownerScanIcon}Start scanner</button><button class="ow-quiet" data-ow-action="stop-camera" hidden>Stop camera</button><span data-ow-camera-hint>Allow camera access when your browser asks.</span></div><p class="ow-scan-feedback" data-ow-scan-feedback role="status" aria-live="polite" hidden></p><p class="ow-form-error" data-ow-camera-error role="alert" hidden></p><div class="ow-manual-divider"><span>or enter their code</span></div><form data-ow-form="lookup" class="ow-lookup-form"><label for="ow-code">CUSTOMER BINGO CODE</label><div><input id="ow-code" name="code" type="text" spellcheck="false" autocomplete="off" autocapitalize="characters" required placeholder="Paste their code or QR link" aria-describedby="ow-code-help"><button class="ow-secondary" type="submit">Look up bingo ${ownerIcon('arrow')}</button></div><small id="ow-code-help">Find the code below the QR on the customer’s screen.</small><p class="ow-form-error" data-ow-error role="alert" hidden></p></form></section><aside class="ow-how-card"><div class="ow-kicker">GOOD TASTE. A SIMPLE ROUTINE.</div><h2>Three little steps.</h2><ol><li><span>1</span><div><h3>Find their bingo.</h3><p>Scan the customer’s personal QR code, or enter their bingo code.</p></div></li><li><span>2</span><div><h3>Pick their discoveries.</h3><p>Choose every category they purchased. More than one? Tick them all.</p></div></li><li><span>3</span><div><h3>A little “okay”.</h3><p>Confirm the purchase. New stamps appear on their bingo automatically.</p></div></li></ol><div class="ow-how-note">${ownerIcon('check')}Already collected stamps stay marked. Each category counts once.</div></aside></div>${searchMarkup()}<section data-ow-last>${customer?summaryMarkup(customer):'<div class="ow-empty-recent">'+ownerIcon('passport')+'<span>Your first scan is waiting. Their next favourite is, too.</span></div>'}</section>`);
    renderSearch();
    if(!document.hidden)startCamera();
  }
  async function authenticate(form){
    if(authBusy)return;authBusy=true;
    const button=form.querySelector('button');button.disabled=true;showError('');
    try{
      await api('/api/owner/login',{method:'POST',body:{code:String(new FormData(form).get('code')||'').trim()}});
      if(disposed)return;
      ownerSessionGeneration++;
      showDashboard();
    }catch(error){
      if(!disposed){
        showError(error?.status===401?'That owner access code wasn’t accepted. Check the code and try again.':errorText(error));
        form.querySelector('input')?.focus();
      }
    }
    finally{authBusy=false;if(button.isConnected)button.disabled=false;}
  }
  function scanFeedback(message){
    const feedback=select('[data-ow-scan-feedback]');if(!feedback)return;
    if(feedback.textContent!==message)feedback.textContent=message;
    feedback.hidden=!message;
  }
  function handleScan(raw){
    if(disposed||lookupBusy||!authenticated||document.hidden||select('#owner-modal')?.open)return;
    const now=Date.now();
    if(now-lastScanAttempt<750||(raw===lastScanPayload&&now-lastScanAttempt<4000))return;
    lastScanPayload=raw;lastScanAttempt=now;
    return lookup(raw,{source:'scan'});
  }
  async function lookup(value,{source='manual'}={}){
    if(disposed||!authenticated||lookupBusy)return;
    const sessionGeneration=ownerSessionGeneration;
    let code;
    try{code=ownerReadCode(value);}
    catch(error){if(source==='scan')scanFeedback('That isn’t an Umami Bingo QR code. Keep the camera on the customer’s personal QR code.');else showError(errorText(error));return;}
    if(source==='scan')scanFeedback('Checking this customer’s bingo…');else showError('');
    lookupBusy=true;renderSearch();
    const button=select('[data-ow-form="lookup"] button');if(button){button.disabled=true;button.textContent='Finding bingo…';}
    try{
      const result=await api(`/api/owner/customer?code=${encodeURIComponent(code)}`);
      if(disposed||!authenticated||sessionGeneration!==ownerSessionGeneration)return;
      customer=result.customer;scanFeedback('');openCustomer(customer);
    }catch(error){
      if(disposed||!authenticated||sessionGeneration!==ownerSessionGeneration)return;
      if(error?.status===401){stopCamera();authenticated=false;showAuth();showError('Please sign in again to scan bingo cards.');return;}
      const message=error?.status===404?'No customer was found for this QR code. Keep scanning, or search by name or email below.':`${errorText(error)} Try again, or search for the customer by name or email.`;
      if(source==='scan')scanFeedback(message);
      else if(source==='search'){searchError=message;renderSearch();}
      else showError(message);
    }finally{
      lookupBusy=false;openingSearchCode='';
      if(button?.isConnected){button.disabled=false;button.innerHTML=`Look up bingo ${ownerIcon('arrow')}`;}
      if(!disposed)renderSearch();
    }
  }
  function openSearchCustomer(index){
    if(lookupBusy||searchBusy||saveBusy)return;
    const entry=searchResults[index];if(!entry)return;
    openingSearchCode=entry.code;searchError='';
    return lookup(entry.code,{source:'search'});
  }
  function categoryGridMarkup(value,{correction=false,locked=false}={}){
    return `<fieldset class="ow-category-grid ow-bingo-options ${correction?'ow-correction-grid':''}" ${locked?'disabled':''}><legend class="ow-sr-only">${correction?'Saved stamps to keep':'Categories purchased'}</legend>${BOARD_CELLS.map(c=>{
      const collected=Boolean(value.stamps?.[c.id]);
      const selected=correction?collected&&!pendingCorrection?.categories.includes(c.id):Boolean(pendingVisit?.categories.includes(c.id));
      const disabled=correction?!collected:collected;
      const detail=correction?collected?'Saved stamp':'Not stamped':collected?'Saved stamp':c.description;
      return `<label class="ow-category-option ${collected?'is-collected':''}"><input type="checkbox" name="categories" value="${c.id}" ${disabled?'disabled':''} ${selected?'checked':''}><span class="ow-option-icon">${ownerIcon(c.icon)}</span><span class="ow-option-copy"><b>${ownerEscape(c.name)}</b><small data-ow-category-note>${ownerEscape(detail)}</small></span><span class="ow-option-tick" aria-hidden="true">${collected?'✓':''}</span></label>`;
    }).join('')}</fieldset>`;
  }
  function correctionMarkup(value){
    const locked=Boolean(pendingCorrection);
    return `<div class="ow-correction-banner"><div><b>Correct a mistake</b><p>Untick any saved stamps added by mistake. Nothing changes until you confirm.</p></div><button class="ow-quiet" data-ow-action="purchase-mode" ${locked?'disabled':''}>Back to purchases</button></div><form data-ow-form="corrections">${categoryGridMarkup(value,{correction:true,locked})}<p class="ow-modal-error" data-ow-correction-error role="alert" ${locked?'':'hidden'}>${locked?'This correction has an unconfirmed save. Retry to check the same removal without affecting any later stamps.':''}</p><button class="ow-primary ow-full ow-remove-button" type="submit" data-ow-remove ${locked?'':'disabled'}>${locked?'Retry removal':'Remove stamps'} ${ownerIcon('close')}</button><section class="ow-correction-confirm" data-ow-correction-confirm hidden><h3>Remove mistaken stamps?</h3><p><span data-ow-removal-count></span> The customer will see this update and discount eligibility will be recalculated. Previously used discounts stay used.</p><div><button class="ow-quiet" type="button" data-ow-action="cancel-removal">Keep editing</button><button class="ow-primary" type="button" data-ow-action="confirm-removal">Confirm removal ${ownerIcon('check')}</button></div></section><button class="ow-secondary ow-full" type="button" data-ow-action="reload-bingo" hidden>Reload bingo ${ownerIcon('arrow')}</button><p class="ow-save-note">Only saved stamps can be removed here. Purchases and reward redemption history are kept.</p></form>`;
  }
  function resetMarkup(value){
    const bingo=getBingoStatus(value.stamps),rewards=getRewardStatus(value);
    if(resetNeedsReload)return `<section class="ow-reset-confirm"><h3>Reload this card first.</h3><p class="ow-modal-error" role="alert">${ownerEscape(resetError||'This card changed. Reload it and review the latest stamps and discounts before continuing.')}</p><button type="button" class="ow-secondary" data-ow-action="reload-card" ${saveBusy?'disabled':''}>${saveBusy?'Reloading…':'Reload card'} ${ownerIcon('arrow')}</button></section>`;
    return `<section class="ow-reset-confirm" aria-labelledby="ow-reset-heading"><h3 id="ow-reset-heading">${pendingReset?'Confirm the same reset.':'Start a fresh card?'}</h3><p>This resets <b>${ownerEscape(ownerCustomerName(value))}</b>’s current card: ${bingo.count} ${bingo.count===1?'stamp':'stamps'} and ${rewards.count} used ${rewards.count===1?'discount':'discounts'}. Any unused discounts on this card will also be cleared. The new card starts with no stamps and can earn its own discounts.</p><p>The customer’s account, personal QR code and previous purchase and card history are kept.</p>${resetError?`<p class="ow-modal-error" role="alert">${ownerEscape(resetError)}</p>`:''}<div>${pendingReset?'':`<button type="button" class="ow-quiet" data-ow-action="cancel-reset" ${saveBusy?'disabled':''}>Keep current card</button>`}<button type="button" class="ow-primary ow-reset-danger" data-ow-action="confirm-reset" ${saveBusy?'disabled':''}>${saveBusy?'Resetting card…':pendingReset?'Retry same reset':'Confirm reset'}</button></div></section>`;
  }
  function modalMarkup(value,notice=''){
    const bingo=getBingoStatus(value.stamps),name=ownerCustomerName(value),total=bingo.total||BOARD_CELLS.length;
    const purchaseRetry=Boolean(pendingVisit),rewardLocked=Boolean(pendingRedemption||selectedRewardId||redemptionNeedsReload);
    const locked=purchaseRetry||rewardLocked||saveBusy||Boolean(pendingReset)||resetReview||resetNeedsReload;
    const normal=`<div class="ow-mode-bar"><span>Verify this purchase</span><div class="ow-card-actions"><button class="ow-quiet" data-ow-action="correct-stamps" ${locked||!bingo.count?'disabled':''}>Correct stamps</button><button type="button" class="ow-quiet ow-reset-link" data-ow-action="reset-card" ${locked?'disabled':''}>Reset card</button></div></div><p class="ow-modal-intro">Select every category in this purchase. Green stamps are already saved.</p><p class="ow-stamp-key"><span>Green = saved</span><span>Red = selected for this purchase</span></p><form data-ow-form="stamps">${categoryGridMarkup(value,{locked})}${bingo.count?`<div class="ow-correction-shortcut"><p>Need to undo a green stamp?</p><button type="button" class="ow-secondary" data-ow-action="correct-stamps" ${locked?'disabled':''}>Correct saved stamps</button></div>`:''}<p class="ow-modal-error" data-ow-save-error role="alert" ${purchaseRetry?'':'hidden'}>${purchaseRetry?'This visit has an unconfirmed save. Retry to check the same purchase without adding it twice.':''}</p><button class="ow-primary ow-full" type="submit" data-ow-confirm ${purchaseRetry&&!rewardLocked&&!saveBusy?'':'disabled'}>${purchaseRetry?'Retry confirmation':'Okay, add stamps'} ${ownerIcon('check')}</button><p class="ow-save-note">${bingo.blackout?`All ${total} purchase categories are collected. Their card is a blackout.`:'Only select categories from a purchase you have checked.'}</p></form>${rewardMarkup(value,bingo)}`;
    return `<div class="ow-modal-header"><div class="ow-kicker">${resetReview||pendingReset||resetNeedsReload?'START A NEW CARD':correctionMode?'CHECK THE SAVED STAMPS':'VERIFY THE PURCHASE'}</div><button class="ow-modal-close" data-ow-action="close-modal" aria-label="Close bingo" ${saveBusy?'disabled':''}>${ownerIcon('close')}</button></div><h2 id="ow-modal-title">${resetReview||pendingReset||resetNeedsReload?'Reset their card.':correctionMode?'Correct their bingo.':'What did they get?'}</h2><div class="ow-modal-person"><span class="ow-customer-avatar">${ownerEscape(name.charAt(0).toUpperCase())}</span><div><b>${ownerEscape(name)}</b>${value.email?`<small class="ow-modal-email">${ownerEscape(value.email)}</small>`:''}<span>${bingo.count} of ${total} purchase stamps · ${ownerEscape(value.code.slice(0,4))}…${ownerEscape(value.code.slice(-4))}</span></div></div>${notice?`<p class="ow-correction-success" role="status">${ownerEscape(notice)}</p>`:''}${resetReview||pendingReset||resetNeedsReload?resetMarkup(value):correctionMode?correctionMarkup(value):normal}`;
  }
  function rewardMarkup(value){
    const rewards=getRewardStatus(value),selected=rewards.availableRewards.find(reward=>reward.id===selectedRewardId);
    const pending=pendingRedemption,discount=pending?.rewardId==='blackout'?25:pending?10:selected?.discount;
    const blocked=Boolean(saveBusy||pendingVisit||pendingCorrection||pending||selectedRewardId||redemptionNeedsReload||rewardUsedThisReview);
    const lineCount=rewards.availableRewards.filter(reward=>reward.discount===10).length;
    const choices=rewards.availableRewards.map(reward=>`<div class="ow-reward-choice"><div><b>${reward.discount}% discount</b><span>${ownerEscape(reward.label)}</span></div><button type="button" class="ow-secondary" data-ow-action="redeem" data-ow-reward-id="${ownerEscape(reward.id)}" aria-label="Use ${reward.discount}% discount for ${ownerEscape(reward.label)}" ${blocked?'disabled':''}>Use ${reward.discount}% discount</button></div>`).join('');
    const history=rewards.usedRewards.map(reward=>`<li><span>${reward.discount===10||reward.discount===25?`${reward.discount}% discount used · ${ownerEscape(reward.label)}`:ownerEscape(reward.label)}</span>${reward.date&&!Number.isNaN(Date.parse(reward.date))?`<time datetime="${ownerEscape(reward.date)}">${ownerEscape(new Date(reward.date).toLocaleDateString())}</time>`:''}</li>`).join('');
    const lineProgress=rewards.lines?`<span>${rewards.lines.completed} of ${rewards.lines.total} lines completed · ${rewards.lines.used} line ${rewards.lines.used===1?'coupon':'coupons'} used</span>`:'';
    let confirmation='';
    if(pending){
      const reward=rewards.availableRewards.find(reward=>reward.id===pending.rewardId)||rewards.usedRewards.find(reward=>reward.id===pending.rewardId);
      confirmation=`<div class="ow-reward-confirm" data-ow-redeem-confirm><h3>Confirm the same ${discount}% discount.</h3>${reward?`<p class="ow-reward-selected">${ownerEscape(reward.label)}</p>`:''}<p>${ownerEscape(redemptionError||'This coupon has an unconfirmed save. Retry to check its result without using another coupon.')}</p><button type="button" class="ow-primary" data-ow-action="confirm-redeem" ${saveBusy?'disabled':''}>${saveBusy?'Confirming…':`Retry ${discount}% discount`}</button></div>`;
    }else if(selected){
      confirmation=`<div class="ow-reward-confirm" data-ow-redeem-confirm><h3>Use ${selected.discount}% discount now?</h3><p class="ow-reward-selected">${ownerEscape(selected.label)}</p><p>Confirm this coupon for the purchase you have checked. Use one coupon per purchase; coupons cannot be combined. Other unused coupons are kept for separate purchases.</p><div><button type="button" class="ow-quiet" data-ow-action="cancel-redeem">Cancel</button><button type="button" class="ow-primary" data-ow-action="confirm-redeem">Confirm ${selected.discount}% discount ${ownerIcon('check')}</button></div></div>`;
    }
    return `<section class="ow-rewards" aria-label="Card discounts"><h3>Discounts for this card.</h3><p class="ow-reward-terms">10% once for every completed row, column or diagonal: up to 10 line coupons. Plus 25% once for the full card. Use one coupon per purchase; coupons cannot be combined.</p><p class="ow-reward-count"><b>${lineCount} unused 10% line ${lineCount===1?'coupon':'coupons'} available</b>${lineProgress}</p>${choices||`<p class="ow-reward-note">${rewards.usedRewards.length?'No unused coupon is available right now.':'Complete a row, column or diagonal to unlock a 10% coupon.'}</p>`}${rewardUsedThisReview?'<p class="ow-reward-note" role="status">Discount recorded for this purchase. Close this card and reopen it when checking a separate purchase to use another available coupon.</p>':''}${confirmation}${redemptionNeedsReload?`<div class="ow-reward-confirm" role="alert"><p>${ownerEscape(redemptionError||'Reload this card and review its discounts before continuing.')}</p><button type="button" class="ow-secondary" data-ow-action="reload-rewards" ${saveBusy?'disabled':''}>Reload discounts</button></div>`:''}${history?`<div class="ow-reward-history"><h4>Used discounts · ${rewards.count}</h4><ul aria-label="Redeemed discounts">${history}</ul></div>`:''}${rewards.legacyUnknown?'<p class="ow-reward-note">A previous reward was used before its percentage was recorded. Its history is preserved; no further coupon is automatically available on this card.</p>':''}</section>`;
  }
  function clearRewardReview(){
    pendingRedemption=null;selectedRewardId=null;redemptionNeedsReload=false;redemptionError='';rewardUsedThisReview=false;
  }
  function clearResetReview(){
    resetReview=false;pendingReset=null;resetNeedsReload=false;resetError='';
  }
  function renderCustomerModal(notice=''){
    if(modalCustomer)select('[data-ow-modal-content]').innerHTML=modalMarkup(modalCustomer,notice);
  }
  function openCustomer(value,{correction=false,notice='',redeemedThisReview=rewardUsedThisReview&&modalCustomer?.code===value.code}={}){
    stopCamera();modalCustomer=value;correctionStale=false;clearRewardReview();clearResetReview();
    pendingVisit=pendingVisits.get(value.code)||null;
    pendingCorrection=pendingCorrections.get(value.code)||null;
    pendingRedemption=pendingRedemptions.get(value.code)||null;
    pendingReset=pendingResets.get(value.code)||null;
    rewardUsedThisReview=redeemedThisReview;
    correctionMode=!pendingVisit&&!pendingRedemption&&!pendingReset&&(correction||Boolean(pendingCorrection));
    renderCustomerModal(notice);
    const dialog=select('#owner-modal');if(!dialog.open)dialog.showModal();
  }
  function updateSelection(){
    if(resetReview||pendingReset||resetNeedsReload)return;
    if(correctionMode){
      if(pendingCorrection||correctionStale||saveBusy)return;
      const categories=correctionCategories(),button=select('[data-ow-remove]');
      if(button){button.disabled=categories.length===0;button.hidden=false;button.textContent=categories.length?`Remove ${categories.length} ${categories.length===1?'stamp':'stamps'}`:'Remove stamps';}
      select('[data-ow-correction-confirm]').hidden=true;
      select('[data-ow-form="corrections"]').querySelectorAll('label.is-collected').forEach(label=>{label.querySelector('[data-ow-category-note]').textContent=label.querySelector('input').checked?'Saved stamp':'Will be removed';});
      return;
    }
    if(pendingVisit||pendingRedemption||selectedRewardId||redemptionNeedsReload||saveBusy)return;
    const count=select('[data-ow-form="stamps"]')?.querySelectorAll('input[name="categories"]:checked').length||0;
    const button=select('[data-ow-confirm]');if(button){button.disabled=count===0;button.innerHTML=`${count?`Okay, add ${count} ${count===1?'stamp':'stamps'}`:'Okay, add stamps'} ${ownerIcon('check')}`;}
  }
  async function saveStamps(form){
    if(saveBusy||!modalCustomer||correctionMode||pendingCorrection||pendingRedemption||selectedRewardId||redemptionNeedsReload||resetReview||pendingReset||resetNeedsReload)return;
    if(!pendingVisit){
      const fields=new FormData(form),categories=fields.getAll('categories');
      if(!categories.length)return;
      pendingVisit={code:modalCustomer.code,cardVersion:modalCustomer.cardVersion||0,categories,directOrder:false,requestId:createRequestId()};
      pendingVisits.set(modalCustomer.code,pendingVisit);
    }
    const payload=pendingVisit;saveBusy=true;
    const button=select('[data-ow-confirm]');button.disabled=true;button.textContent='Adding discoveries…';
    form.querySelectorAll('fieldset,input').forEach(el=>el.disabled=true);
    container.querySelectorAll('[data-ow-action="correct-stamps"]').forEach(button=>button.disabled=true);
    container.querySelectorAll('[data-ow-action="redeem"]').forEach(button=>button.disabled=true);
    select('[data-ow-action="reset-card"]').disabled=true;
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
      if([400,401,409,410].includes(error?.status)){
        pendingVisits.delete(payload.code);pendingVisit=null;
        if(error.status===401){modalCustomer=null;showAuth();showError('Please sign in again to review this card.');return;}
        resetNeedsReload=true;resetError=`${errorText(error)} Reload this card before confirming another purchase.`;
        saveBusy=false;renderCustomerModal();return;
      }
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
    if(saveBusy||pendingVisit||pendingRedemption||selectedRewardId||redemptionNeedsReload||resetReview||pendingReset||resetNeedsReload||!modalCustomer||!getBingoStatus(modalCustomer.stamps).count)return;
    if(select('[data-ow-form="stamps"] input[name="categories"]:checked')){
      const error=select('[data-ow-save-error]');error.textContent='Untick the red purchase selections or confirm them first. Then choose Correct stamps to remove a saved green stamp.';error.hidden=false;error.tabIndex=-1;error.focus();
      return;
    }
    openCustomer(modalCustomer,{correction:true});
  }
  function showCorrectionConfirm(){
    if(saveBusy||correctionStale||!correctionMode||!modalCustomer||pendingVisit||pendingRedemption)return;
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
    if(saveBusy||correctionStale||!correctionMode||!modalCustomer||pendingVisit||pendingRedemption)return;
    if(!pendingCorrection){
      const categories=correctionCategories();if(!categories.length)return;
      pendingCorrection={code:modalCustomer.code,cardVersion:modalCustomer.cardVersion||0,categories,requestId:createRequestId(),expectedStamps:Object.fromEntries(categories.map(id=>[id,modalCustomer.stamps[id]]))};
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
      saveBusy=false;openCustomer(customer,{correction:true,notice:`${count} mistaken ${count===1?'stamp removed':'stamps removed'}. The customer’s bingo is updated.`});
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
  function showReset(){
    if(saveBusy||lookupBusy||!modalCustomer||correctionMode||correctionStale||pendingVisit||pendingCorrection||pendingRedemption||selectedRewardId||redemptionNeedsReload||pendingReset||resetNeedsReload)return;
    if(select('[data-ow-form="stamps"] input:checked')){
      const error=select('[data-ow-save-error]');error.textContent='Untick or confirm the selected purchase first. Then choose Reset card.';error.hidden=false;error.tabIndex=-1;error.focus();return;
    }
    resetReview=true;resetError='';renderCustomerModal();
    select('[data-ow-action="cancel-reset"]')?.focus();
  }
  function cancelReset(){
    if(saveBusy||pendingReset||resetNeedsReload)return;
    clearResetReview();renderCustomerModal();select('[data-ow-action="reset-card"]')?.focus();
  }
  async function resetCard(){
    if(saveBusy||!modalCustomer||!resetReview&&!pendingReset||resetNeedsReload||pendingVisit||pendingCorrection||pendingRedemption||selectedRewardId||redemptionNeedsReload)return;
    if(!pendingReset){
      pendingReset={code:modalCustomer.code,requestId:createRequestId(),cardVersion:modalCustomer.cardVersion||0,expectedStamps:structuredClone(modalCustomer.stamps||{}),expectedRedemptions:structuredClone(modalCustomer.redemptions||[])};
      pendingResets.set(modalCustomer.code,pendingReset);
    }
    const payload=pendingReset;
    saveBusy=true;resetError='';renderCustomerModal();
    try{
      const result=await api('/api/owner/card/reset',{method:'POST',body:payload});
      pendingResets.delete(payload.code);pendingReset=null;
      if(disposed)return;
      pendingVisits.delete(payload.code);pendingCorrections.delete(payload.code);pendingRedemptions.delete(payload.code);
      customer=result.customer;saveBusy=false;
      select('[data-ow-last]').innerHTML=summaryMarkup(customer);
      openCustomer(customer,{notice:'New card started with no stamps or used discounts. Their account and QR code are unchanged; previous card history is kept.',redeemedThisReview:false});
      toast('Card reset. The customer can start collecting stamps again.');
    }catch(failure){
      if(disposed)return;
      if([400,401,403,409,410].includes(failure?.status)){
        pendingResets.delete(payload.code);pendingReset=null;
        if(failure.status===401){modalCustomer=null;clearResetReview();showAuth();showError('Please sign in again to review this card.');return;}
        resetNeedsReload=true;resetError=`${errorText(failure)} Reload the card and review it before trying another reset.`;
      }else{
        resetError=`${errorText(failure)} Retry this same reset to confirm its result. A retry will not start another card.`;
      }
    }finally{
      saveBusy=false;
      if(!disposed&&modalCustomer?.code===payload.code&&(pendingReset||resetNeedsReload))renderCustomerModal();
    }
  }
  async function reloadCard(){
    if(saveBusy||lookupBusy||!modalCustomer||pendingReset)return;
    const code=modalCustomer.code,dialog=select('#owner-modal');
    saveBusy=true;renderCustomerModal();
    try{
      const result=await api(`/api/owner/customer?code=${encodeURIComponent(code)}`);
      if(disposed||!dialog.open||modalCustomer?.code!==code)return;
      customer=result.customer;select('[data-ow-last]').innerHTML=summaryMarkup(customer);
      saveBusy=false;openCustomer(customer,{notice:'Card reloaded. Review the latest stamps and discounts before making changes.',redeemedThisReview:false});
    }catch(failure){
      if(disposed)return;
      if(failure?.status===401){modalCustomer=null;clearResetReview();showAuth();showError('Please sign in again to review this card.');return;}
      resetNeedsReload=true;resetError=`${errorText(failure)} Reload the card before continuing.`;
    }finally{
      saveBusy=false;
      if(!disposed&&dialog.open&&modalCustomer?.code===code&&resetNeedsReload)renderCustomerModal();
    }
  }
  function showRedemption(rewardId){
    if(saveBusy||pendingVisit||pendingCorrection||pendingRedemption||redemptionNeedsReload||rewardUsedThisReview||correctionMode||resetReview||pendingReset||resetNeedsReload||!modalCustomer)return;
    if(!getRewardStatus(modalCustomer).availableRewards.some(reward=>reward.id===rewardId))return;
    if(select('[data-ow-form="stamps"] input[name="categories"]:checked')){
      const error=select('[data-ow-save-error]');error.textContent='Confirm the selected purchase stamps first, then review this bingo to use a discount.';error.hidden=false;return;
    }
    selectedRewardId=rewardId;renderCustomerModal();
    select('[data-ow-action="cancel-redeem"]')?.focus();
  }
  function cancelRedemption(){
    if(saveBusy||pendingRedemption)return;
    const rewardId=selectedRewardId;selectedRewardId=null;renderCustomerModal();
    select(`[data-ow-reward-id="${rewardId}"]`)?.focus();
  }
  async function reloadRewardState(notice='Bingo reloaded. Review the available and used discounts.'){
    if(saveBusy||!modalCustomer||pendingRedemption)return;
    const code=modalCustomer.code,dialog=select('#owner-modal');
    saveBusy=true;redemptionNeedsReload=true;renderCustomerModal();
    try{
      const result=await api(`/api/owner/customer?code=${encodeURIComponent(code)}`);
      if(disposed||!dialog.open||modalCustomer?.code!==code)return;
      customer=result.customer;select('[data-ow-last]').innerHTML=summaryMarkup(customer);
      saveBusy=false;openCustomer(customer,{notice});
    }catch(failure){
      if(disposed||!dialog.open||modalCustomer?.code!==code)return;
      if(failure?.status===401){modalCustomer=null;clearRewardReview();showAuth();showError('Please sign in again to review discounts.');return;}
      redemptionError=`${errorText(failure)} Reload the card before continuing.`;
    }finally{
      saveBusy=false;
      if(!disposed&&dialog.open&&modalCustomer?.code===code&&redemptionNeedsReload)renderCustomerModal();
    }
  }
  async function redeem(){
    if(saveBusy||pendingVisit||pendingCorrection||redemptionNeedsReload||rewardUsedThisReview||correctionMode||resetReview||pendingReset||resetNeedsReload||!modalCustomer)return;
    if(!pendingRedemption){
      if(!getRewardStatus(modalCustomer).availableRewards.some(reward=>reward.id===selectedRewardId))return;
      pendingRedemption={code:modalCustomer.code,cardVersion:modalCustomer.cardVersion||0,rewardId:selectedRewardId,requestId:createRequestId()};
      pendingRedemptions.set(modalCustomer.code,pendingRedemption);
    }
    const payload=pendingRedemption,discount=payload.rewardId==='blackout'?25:10;
    saveBusy=true;redemptionError='';renderCustomerModal();
    try{
      const result=await api('/api/owner/redeem',{method:'POST',body:payload});
      pendingRedemptions.delete(payload.code);pendingRedemption=null;
      if(disposed)return;
      customer=result.customer;saveBusy=false;
      select('[data-ow-last]').innerHTML=summaryMarkup(customer);
      openCustomer(customer,{notice:`${result.redemption?.discount||discount}% discount recorded for this purchase. Other unused discounts are kept for a separate purchase.`,redeemedThisReview:true});
      toast(`${result.redemption?.discount||discount}% discount marked as used.`);
    }catch(failure){
      if(disposed)return;
      if([400,401,409,410].includes(failure?.status)){
        pendingRedemptions.delete(payload.code);pendingRedemption=null;selectedRewardId=null;
        if(failure.status===401){modalCustomer=null;clearRewardReview();showAuth();showError('Please sign in again to review this discount.');return;}
        redemptionNeedsReload=true;redemptionError=`${errorText(failure)} Reload this card and review its discounts before continuing.`;
        saveBusy=false;
        if(failure.status===409){await reloadRewardState('This discount changed before confirmation. Review the refreshed available and used discounts.');return;}
      }else{
        redemptionError=`${errorText(failure)} Retry this same ${discount}% discount to confirm its result before taking another action.`;
      }
    }finally{
      saveBusy=false;
      if(!disposed&&modalCustomer?.code===payload.code&&(pendingRedemption||redemptionNeedsReload))renderCustomerModal();
    }
  }
  async function startCamera(){
    if(disposed||!authenticated||document.hidden||cameraStarting||scanner||lookupBusy||select('#owner-modal')?.open)return;
    const errorEl=select('[data-ow-camera-error]');if(!errorEl)return;errorEl.hidden=true;
    cameraStarting=true;cameraController=new AbortController();
    lastScanPayload='';lastScanAttempt=0;scanFeedback('');
    const controller=cameraController,button=select('[data-ow-action="camera"]');
    button.disabled=true;button.textContent='Opening camera…';
    const hint=select('[data-ow-camera-hint]');if(hint)hint.textContent='Allow camera access when your browser asks.';
    select('[data-ow-action="stop-camera"]').hidden=false;
    try{
      const video=select('[data-ow-video]');
      const active=await startQrScanner(video,handleScan,{signal:controller.signal,continuous:true});
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
  function closeCustomer(){if(saveBusy)return;select('#owner-modal')?.close();modalCustomer=null;pendingVisit=null;pendingCorrection=null;correctionMode=false;correctionStale=false;clearRewardReview();clearResetReview();}
  async function onClick(event){
    const button=event.target.closest('[data-ow-action]');if(!button||!container.contains(button))return;
    event.preventDefault();
    switch(button.dataset.owAction){
      case'exit':if(!saveBusy){clearSearch();stopCamera();onExit();}break;
      case'logout':{
        if(saveBusy)return;clearSearch();stopCamera();authenticated=false;ownerSessionGeneration++;button.disabled=true;
        try{await api('/api/owner/logout',{method:'POST',body:{}});if(!disposed)showAuth();}
        catch(error){if(!disposed){authenticated=true;toast(errorText(error));button.disabled=false;}}
        break;
      }
      case'camera':startCamera();break;
      case'stop-camera':stopCamera();break;
      case'close-modal':closeCustomer();break;
      case'review':if(customer)lookup(customer.code);break;
      case'open-search':openSearchCustomer(Number(button.dataset.owResultIndex));break;
      case'clear-search':clearSearch();select('[data-ow-search-input]')?.focus();break;
      case'focus-search':select('[data-ow-search-input]')?.focus();break;
      case'correct-stamps':enterCorrection();break;
      case'reset-card':showReset();break;
      case'cancel-reset':cancelReset();break;
      case'confirm-reset':resetCard();break;
      case'reload-card':reloadCard();break;
      case'purchase-mode':if(!saveBusy&&!pendingCorrection&&!correctionStale&&modalCustomer)openCustomer(modalCustomer);break;
      case'cancel-removal':cancelCorrectionConfirm();break;
      case'confirm-removal':saveCorrection();break;
      case'reload-bingo':reloadCorrection();break;
      case'redeem':showRedemption(button.dataset.owRewardId);break;
      case'cancel-redeem':cancelRedemption();break;
      case'confirm-redeem':redeem();break;
      case'reload-rewards':reloadRewardState();break;
      case'retry-owner':initializeOwner();break;
    }
  }
  function onSubmit(event){
    const form=event.target.closest('[data-ow-form]');if(!form)return;event.preventDefault();
    if(form.dataset.owForm==='auth')authenticate(form);
    if(form.dataset.owForm==='lookup')lookup(new FormData(form).get('code'));
    if(form.dataset.owForm==='search')searchCustomers(form);
    if(form.dataset.owForm==='stamps')saveStamps(form);
    if(form.dataset.owForm==='corrections')showCorrectionConfirm();
  }
  function onVisibility(){if(document.hidden)stopCamera();}
  container.addEventListener('click',onClick);
  container.addEventListener('submit',onSubmit);
  container.addEventListener('change',updateSelection);
  container.addEventListener('input',onSearchInput);
  document.addEventListener('visibilitychange',onVisibility);
  async function initializeOwner(){
    if(disposed||bootBusy)return;
    bootBusy=true;authenticated=false;ownerSessionGeneration++;showLoading();
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
    disposed=true;clearSearch();stopCamera();
    select('#owner-modal')?.close();
    container.removeEventListener('click',onClick);
    container.removeEventListener('submit',onSubmit);
    container.removeEventListener('change',updateSelection);
    container.removeEventListener('input',onSearchInput);
    document.removeEventListener('visibilitychange',onVisibility);
  };
}
