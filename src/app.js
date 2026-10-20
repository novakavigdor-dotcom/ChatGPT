import {CATEGORIES,BOARD_CELLS,emptyPassport,normalizePassport,getBingoStatus,redeemReward} from './loyalty.js';
import {renderQr} from './qr.js';
import {mountOwner} from './owner.js';

const $=id=>document.getElementById(id),main=$('main'),modal=$('modal');
const icon=name=>`<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const offline=document.querySelector('meta[name="umami-mode"]')?.content==='offline'||!['http:','https:'].includes(location.protocol),STORAGE='umami-bingo-demo-v2';
let state=emptyPassport(),identity=null,role=location.pathname.replace(/\/$/,'')==='/owner'||location.hash==='#owner'?'owner':'customer';
let ownerCleanup=null,pollBusy=false,pollTimer=null,syncStatus=offline?'offline':'connecting',toastTimer,formBusy=false,modalKind='',serverError='';
const registered=()=>Boolean(identity&&!state.needsProfile);
function randomCode(){return [...crypto.getRandomValues(new Uint8Array(16))].map(n=>n.toString(16).padStart(2,'0')).join('').toUpperCase();}
function acceptCustomer(customer){identity={id:customer.id,code:customer.code};state=normalizePassport(customer);syncStatus=offline?'offline':'connected';}
function loadOffline(){try{const value=JSON.parse(localStorage.getItem(STORAGE));if(value?.identity){identity=value.identity;state=normalizePassport(value.customer);}}catch{}}
function saveOffline(){if(!offline)return;try{localStorage.setItem(STORAGE,JSON.stringify({identity,customer:state}));}catch{toast('Browser storage is unavailable. Keep this tab open to retain this demo.');}}
function publicOffline(){return {...state,id:identity?.id,code:identity?.code};}
const cleanCode=value=>String(value||'').replace(/^UMAMI\s*:/i,'').replace(/[\s-]/g,'').toUpperCase();
async function offlineApi(path,options={}){
  const body=options.body||{};loadOffline();
  if(path==='/api/status')return {ownerConfigured:true,ownerSetupAllowed:true};
  if(path==='/api/owner/session')return {authenticated:true};
  if(path==='/api/customer'&&options.method==='POST'){
    if(registered())return {customer:publicOffline()};
    const firstName=String(body.firstName||'').trim(),lastName=String(body.lastName||'').trim(),email=String(body.email||'').trim().toLowerCase();
    if(!firstName||!lastName||!/^\S+@\S+\.\S+$/.test(email))throw new Error('Enter your first name, last name and a valid email.');
    identity={id:randomCode(),code:randomCode()};
    state={...emptyPassport(),firstName,lastName,email,name:firstName+' '+lastName,needsProfile:false};saveOffline();return {customer:publicOffline()};
  }
  if(path==='/api/customer/login'){
    const lastName=typeof body.lastName==='string'?body.lastName.trim().normalize('NFKC').toLowerCase():'';
    const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
    if(!identity||!lastName||!email||email!==state.email||lastName!==state.lastName.trim().normalize('NFKC').toLowerCase()){const error=new Error('The last name or email is incorrect.');error.status=401;throw error;}
    return {customer:publicOffline()};
  }
  if(path==='/api/customer'&&options.method==='PATCH'){state=normalizePassport({...state,...body});saveOffline();return {customer:publicOffline()};}
  if(path==='/api/customer/logout'||path==='/api/owner/logout')return {authenticated:false};
  if(path==='/api/customer'){if(!registered()){const error=new Error('Create your bingo account first.');error.status=401;throw error;}return {customer:publicOffline()};}
  if(path.startsWith('/api/owner/customers?')){const query=(new URL(path,'https://umami.local').searchParams.get('q')||'').trim().normalize('NFKC').toLowerCase();if(query.length<2||query.length>120)throw new Error('Enter between 2 and 120 characters to search.');const matches=registered()&&[state.name,state.email].some(value=>value.normalize('NFKC').toLowerCase().includes(query));return {customers:matches?[publicOffline()]:[]};}
  if(path.startsWith('/api/owner/customer?')){const code=new URL(path,'https://umami.local').searchParams.get('code');if(!registered()||cleanCode(code)!==identity.code)throw new Error('This offline demo can find only the bingo card in this browser.');return {customer:publicOffline()};}
  if(path==='/api/owner/stamps'){
    if(cleanCode(body.code)!==identity?.code)throw new Error('Bingo account not found.');
    const selected=[...new Set(body.categories||[])];if(!selected.length||selected.some(id=>!CATEGORIES.some(c=>c.id===id)))throw new Error('Select a valid food square.');
    const date=new Date().toISOString(),earned=selected.filter(id=>!state.stamps[id]);for(const id of earned)state.stamps[id]=date;saveOffline();return {customer:publicOffline(),earned};
  }
  if(path==='/api/owner/stamps/remove'){
    if(cleanCode(body.code)!==identity?.code)throw new Error('Bingo account not found.');
    const selected=[...new Set(body.categories||[])];if(!selected.length||selected.some(id=>!CATEGORIES.some(c=>c.id===id)))throw new Error('Select a valid saved stamp to remove.');
    for(const id of selected)if(state.stamps[id]&&state.stamps[id]!==body.expectedStamps?.[id]){const error=new Error('This card changed. Reload it before correcting stamps.');error.status=409;throw error;}
    const removed=selected.filter(id=>state.stamps[id]);for(const id of removed)delete state.stamps[id];saveOffline();return {customer:publicOffline(),removed};
  }
  if(path==='/api/owner/redeem'){if(cleanCode(body.code)!==identity?.code)throw new Error('Bingo account not found.');state=redeemReward(state);saveOffline();return {customer:publicOffline()};}
  throw new Error('This feature needs the hosted app.');
}
async function api(path,options={}){
  if(offline)return offlineApi(path,options);
  let response;try{response=await fetch(path,{...options,credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json',...options.headers},body:options.body===undefined?undefined:JSON.stringify(options.body),signal:options.signal||AbortSignal.timeout(15000)});}catch{throw new Error('We couldn’t reach the account service. Check your connection and try again.');}
  let data;try{data=await response.json();}catch{throw new Error('The account service is not connected. This site needs its Netlify Functions deployed.');}
  if(!response.ok){const error=new Error(data.error||'We couldn’t save that change. Please try again.');error.status=response.status;throw error;}return data;
}
function toast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),3500);}
function updateStatus(){const text=role==='owner'?(offline?'OFFLINE OWNER DEMO':'OWNER WORKSPACE'):offline?'OFFLINE DEMO · SAME BROWSER ONLY':syncStatus==='connected'?'CONNECTED · STAMPS UPDATE AUTOMATICALLY':syncStatus==='signup'?'YOUR BINGO STARTS HERE':syncStatus==='connecting'?'CONNECTING…':'CONNECTION LOST · TRY AGAIN';$('connection-status').textContent=text;$('connection-status').classList.toggle('connected',syncStatus==='connected');}
function board(){
  const status=getBingoStatus(state.stamps),name=state.name||'Your name goes here';
  // The sprite's rows have different top padding; these offsets keep each food intact.
  const foodRows=['6.2241%','35.2697%','64.8340%','94.3983%'];
  return `<section class="passport-page bingo-page">${serverError?`<div class="connection-banner" role="alert">${escape(serverError)}<button data-action="retry">Try again ${icon('arrow')}</button></div>`:''}<article class="paper-passport menu-bingo" aria-label="Your Umami Sushi menu bingo card"><header class="bingo-masthead"><img src="/assets/umami-logo-000.jpg" alt="Umami Sushi"><h1>MENU BINGO</h1></header><p class="bingo-tagline">Try something different. Get each item square stamped.</p><div class="bingo-identity"><div class="passport-name"><b>NAME:</b><span>${escape(name)}</span><button data-action="account" aria-label="Your account">${icon('passport')}</button></div><button class="bingo-qr-badge" data-action="qr" aria-label="${registered()?'Enlarge your personal bingo QR code':'Create your account to get your bingo QR code'}">${registered()?renderQr('UMAMI:'+identity.code,{size:192,label:state.name+'’s personal bingo QR code'}):icon('qr')}<small>${registered()?'YOUR BINGO QR':'GET YOUR QR'}</small></button></div><div class="bingo-grid">${BOARD_CELLS.map((cell,index)=>`<button style="--food-x:${index%4*100/3}%;--food-y:${foodRows[Math.floor(index/4)]}" class="bingo-square ${state.stamps[cell.id]?'stamped':''}" data-square="${cell.id}" aria-label="${cell.name}: ${state.stamps[cell.id]?'stamped':'not stamped'}">${state.stamps[cell.id]?`<span class="stamp-ring" aria-hidden="true"><span>UMAMI</span><b>✓</b></span>`:''}<strong>${cell.name}</strong><span class="square-description">${cell.description}</span><span class="bingo-food-art" aria-hidden="true"></span>${state.stamps[cell.id]?'<span class="saved-stamp-check" aria-hidden="true">✓</span><small>STAMPED</small>':''}</button>`).join('')}</div>${state.redeemed||status.hasBingo?`<div class="bingo-result ${state.redeemed?'used':'won'}" aria-live="polite"><h2>${state.redeemed?([10,25].includes(state.redeemedDiscount)?state.redeemedDiscount+'% reward redeemed':'Reward redeemed'):status.blackout?'Full card! 25% off':'Bingo! 10% off'}</h2><p>${state.redeemed?'This card’s one reward has been used. Thanks for trying something different.':status.blackout?'All 16 squares collected. Show your QR to staff to redeem.':'Show your QR to staff to redeem, or keep collecting for a full card.'}</p></div>`:''}<div class="pdf-reward-strip"><strong>ANY COMPLETED LINE = 10% OFF</strong><b>FULL CARD = 25% OFF</b></div><div class="bingo-rules"><p>Complete any row, column or diagonal of four.</p><small>One stamp per qualifying item purchased.<br>One reward per card. Discounts cannot be combined.</small><a href="https://umamisushi.ca" target="_blank" rel="noopener">umamisushi.ca</a></div><div class="card-bottom"><span>${status.count} / 16 items stamped</span><button data-action="help">How it works ${icon('help')}</button></div></article><div class="bingo-account-row"><button class="secondary" data-action="qr">${registered()?'Show my bingo QR':'Create my bingo account'} ${icon('qr')}</button>${registered()?`<button class="account-link" data-action="account">${escape(state.email)} · Your account</button>`:''}</div></section>`;
}
function render(){
  document.body.classList.toggle('owner-mode',role==='owner');document.querySelector('.role-switch').innerHTML=`${icon(role==='owner'?'passport':'lock')}<span>${role==='owner'?'Customer version':'Owner version'}</span>`;
  document.querySelector('.avatar').hidden=role==='owner';document.querySelector('.avatar').textContent=(state.firstName||'U').charAt(0).toUpperCase();
  if(role==='owner'){main.innerHTML='<div class="owner-mount"></div>';ownerCleanup=mountOwner({container:main.firstElementChild,api,onExit:()=>switchRole('customer'),toast,offline});}
  else main.innerHTML=board();updateStatus();schedulePoll();
}
function openModal(kind,html,required=false){
  const signupSheet=(kind==='signup'||kind==='login')&&!registered();
  if(modal.open)modal.close();
  modalKind=kind;$('modal-content').innerHTML=html;document.querySelector('.modal-close').hidden=required;
  modal.classList.toggle('signup-form-modal',signupSheet);document.body.classList.toggle('signup-open',signupSheet);
  if(signupSheet)modal.show();else modal.showModal();
}
function closeModal(){if((modalKind==='signup'||modalKind==='login')&&!registered())return;modal.close();modalKind='';}
function signup(mode='signup'){
  const login=mode==='login',profile=mode==='profile'&&registered(),upgrade=identity&&state.needsProfile;
  const fields=login?`<label for="account-last">Last name</label><input id="account-last" name="lastName" autocomplete="family-name" maxlength="60" required placeholder="Last name"><label for="account-email">Email</label><input id="account-email" name="email" type="email" autocomplete="email" maxlength="254" required placeholder="you@example.com">`:`<div class="name-fields"><div><label for="account-first">First name</label><input id="account-first" name="firstName" autocomplete="given-name" maxlength="60" required value="${escape(state.firstName)}" placeholder="First name"></div><div><label for="account-last">Last name</label><input id="account-last" name="lastName" autocomplete="family-name" maxlength="60" required value="${escape(state.lastName)}" placeholder="Last name"></div></div><label for="account-email">Email</label><input id="account-email" name="email" type="email" autocomplete="email" maxlength="254" required value="${escape(state.email)}" placeholder="you@example.com">`;
  openModal(login?'login':profile?'profile':'signup',`<div class="signup-seal">${icon('passport')}</div><span class="eyebrow">${profile?'OFFICIALLY YOURS':login?'GOOD TO HAVE YOU BACK':'WELCOME TO THE UMAMI CLUB'}</span><h2 id="modal-title">${profile?'Your bingo account.':login?'Your bingo card is waiting.':'Good taste starts here.'}</h2><p class="modal-subtitle">${profile?'Keep your details up to date. Your QR code and stamps stay the same.':login?'Enter your last name and email to reopen your bingo card.':'Enter your first name, last name and email to create your own sushi bingo account.'}</p><form id="account-form" data-mode="${login?'login':profile||upgrade?'profile':'signup'}">${fields}<p id="form-error" class="form-error" role="alert" hidden></p><button class="primary full-width" type="submit">${profile?'Save my details':login?'Open my bingo':'Create my bingo account'} ${icon('arrow')}</button></form>${profile?'<button class="subtle-button" data-action="logout">Sign out of this account</button>':`<button class="subtle-button" data-action="${login?'signup':'login'}">${login?'New here? Create your bingo account':'Already have an account? Sign in'}</button>`}<p class="signup-note">${profile?'Use your last name and email to sign in on another device.':login?'Use the last name and email you entered when you created your account.':'Next time, sign in with just your last name and email.'}</p><button class="staff-entry" data-action="owner">Restaurant staff? Owner sign-in ${icon('lock')}</button>${offline?'<p class="offline-note">Offline demo only. Different phones need the hosted app.</p>':''}`,!profile);
}
function showQr(){if(!registered()){signup();return;}const status=getBingoStatus(state.stamps);openModal('qr',`<section class="my-qr-modal"><span class="eyebrow">PRESENT AT THE COUNTER</span><h2 id="modal-title">${escape(state.name)}’s bingo</h2><p class="modal-subtitle">Staff scan this code, select what you got, and stamp your card.</p><div class="large-customer-qr">${renderQr('UMAMI:'+identity.code,{size:264,label:'Your public bingo QR code'})}</div><code class="customer-code">${identity.code.match(/.{4}/g).join(' ')}</code><button class="subtle-button" data-action="copy-code">Copy customer code</button><div class="qr-live-count">${status.count} of 16 items · ${state.redeemed?'Reward used':status.discount?`${status.discount}% off available`:'Keep exploring'}</div><p class="signup-note">Staff use this code to find your bingo card. To sign in again, use your last name and email.</p></section>`);}
function showHelp(){openModal('help',`<span class="eyebrow">SIXTEEN FLAVOURS. SOMETHING NEW.</span><h2 id="modal-title">Your menu bingo.</h2><ol class="help-steps"><li><b>Try an item from the card.</b><p>All 16 squares match a menu category. Each square counts once.</p></li><li><b>Show your personal QR.</b><p>It’s above the grid. Staff scan it and confirm your purchases. If a stamp was added by mistake, the owner can correct it.</p></li><li><b>Get four in a line.</b><p>A complete row, column or diagonal of four earns 10% off. Collect all 16 for 25% off instead.</p></li></ol><div class="important-note">One reward per card. Redeeming the 10% reward means you cannot redeem another 25% on the same card. Corrections update the card’s eligibility, but do not undo an already used reward. Discounts cannot be combined.</div><button class="primary full-width" data-action="qr">Show my bingo QR ${icon('qr')}</button>`);}
function showSquare(id){const category=CATEGORIES.find(c=>c.id===id);if(!category)return;if(!registered()){signup();return;}openModal('square',`<span class="eyebrow">${state.stamps[id]?'A LITTLE STAMP OF APPROVAL':'YOUR NEXT DISCOVERY'}</span><h2 id="modal-title">${escape(category.name)}</h2><p class="modal-subtitle">${category.description?escape(category.description)+'. ':''}${state.stamps[id]?'Already stamped by staff. Each square counts once.':'After a qualifying purchase, let staff scan your QR code and stamp this square.'}</p><button class="primary full-width" data-action="qr">Show my QR code ${icon('qr')}</button>`);}
async function submitAccount(form){if(formBusy)return;formBusy=true;const button=form.querySelector('button[type=submit]');button.disabled=true;const error=$('form-error');error.hidden=true;try{const body=Object.fromEntries(new FormData(form));const mode=form.dataset.mode;const result=await api(mode==='login'?'/api/customer/login':'/api/customer',{method:mode==='profile'?'PATCH':'POST',body});acceptCustomer(result.customer);serverError='';saveOffline();modal.close();modalKind='';render();toast(mode==='profile'?'Your account is updated.':mode==='login'?'Welcome back. Your bingo card is here.':'Your bingo account is ready!');}catch(failure){error.textContent=failure.message;error.hidden=false;}finally{formBusy=false;if(button.isConnected)button.disabled=false;}}
async function switchRole(next){if(formBusy){toast('Your account is saving. Please wait a moment.');return;}if(ownerCleanup){ownerCleanup();ownerCleanup=null;}if(modal.open)modal.close();modalKind='';role=next;try{history.replaceState(null,'',offline?next==='owner'?'#owner':'#passport':next==='owner'?'/owner':'/customer');}catch{}if(next==='customer')await initializeCustomer();else render();}
async function initializeCustomer(){serverError='';if(offline){loadOffline();render();if(!registered())signup();return;}try{const result=await api('/api/customer');acceptCustomer(result.customer);render();if(state.needsProfile)signup();}catch(error){if(error.status===401){state=emptyPassport();identity=null;syncStatus='signup';render();signup();}else{syncStatus='disconnected';serverError=error.message;render();signup();}}}
function schedulePoll(){clearTimeout(pollTimer);pollTimer=null;if(!offline&&role==='customer'&&registered()&&!document.hidden)pollTimer=setTimeout(poll,15000);}
async function poll(){
  if(offline||role!=='customer'||!registered()||document.hidden||pollBusy)return;
  pollBusy=true;
  const customerId=identity.id;
  try{
    const previous=JSON.stringify(state),oldCount=getBingoStatus(state.stamps).count;
    const data=await api('/api/customer');
    if(role!=='customer'||identity?.id!==customerId||document.hidden)return;
    acceptCustomer(data.customer);serverError='';
    if(previous!==JSON.stringify(state)){
      render();
      const newCount=getBingoStatus(state.stamps).count;
      if(newCount>oldCount)toast('A fresh stamp just landed on your card!');
      else if(newCount<oldCount)toast('Staff corrected a stamp on your bingo card.');
      if(modal.open&&modalKind==='qr')showQr();
    }else updateStatus();
  }catch(error){
    if(role!=='customer'||identity?.id!==customerId||document.hidden)return;
    syncStatus='disconnected';updateStatus();
    if(error.status===401){identity=null;state=emptyPassport();render();signup('login');}
  }finally{pollBusy=false;schedulePoll();}
}
async function click(event){const target=event.target.closest('button,a');if(!target)return;const action=target.dataset.action;if(action==='switch-role'||action==='owner'){event.preventDefault();await switchRole(action==='owner'?'owner':role==='owner'?'customer':'owner');return;}if(role==='owner')return;if(target.dataset.square){showSquare(target.dataset.square);return;}switch(action){case'home':event.preventDefault();render();break;case'account':signup(registered()?'profile':'signup');break;case'qr':showQr();break;case'help':showHelp();break;case'close':closeModal();break;case'login':signup('login');break;case'signup':signup();break;case'copy-code':try{await navigator.clipboard.writeText('UMAMI:'+identity.code);target.textContent='Copied ✓';}catch{target.textContent='Select the code above and copy it.';}break;case'logout':await api('/api/customer/logout',{method:'POST',body:{}});identity=null;state=emptyPassport();syncStatus='signup';render();signup('login');break;case'retry':await initializeCustomer();break;}}
document.addEventListener('click',event=>click(event).catch(error=>toast(error.message)));
document.addEventListener('submit',event=>{if(event.target.id==='account-form'){event.preventDefault();submitAccount(event.target);}});
modal.addEventListener('close',()=>document.body.classList.toggle('signup-open',modal.open&&modal.classList.contains('signup-form-modal')));
modal.addEventListener('cancel',event=>{if(!registered())event.preventDefault();});
modal.addEventListener('click',event=>{if(event.target!==modal)return;const rect=modal.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeModal();});
document.addEventListener('visibilitychange',()=>{clearTimeout(pollTimer);pollTimer=null;if(!document.hidden)poll();});
window.addEventListener('storage',event=>{if(offline&&event.key===STORAGE&&role==='customer'){loadOffline();render();}});
if(role==='owner')render();else initializeCustomer();
