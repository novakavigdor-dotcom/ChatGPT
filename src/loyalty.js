export const CATEGORIES = [
  {id:'maki',name:'Maki',description:'Your Choice',icon:'maki'},
  {id:'poke',name:'Poke Bowl',description:'Build your own',icon:'onigiri'},
  {id:'gyoza',name:'Gyoza',description:'Salmon or Vegetarian',icon:'platter'},
  {id:'sushi-pizza',name:'Sushi Pizza',description:'4 Choices',icon:'platter'},
  {id:'handroll',name:'Handroll',description:'Your Choice',icon:'maki'},
  {id:'onigiri',name:'Onigiri',description:'3 Options',icon:'onigiri'},
  {id:'udon',name:'Udon Noodle',description:'3 Options',icon:'ramen'},
  {id:'miso',name:'Miso Soup',description:'',icon:'ramen'},
  // Retain the historical key so existing stamps and line rewards stay attached.
  {id:'nigiri',name:'Sushi Burrito',description:'Your choice',icon:'maki'},
  {id:'sandwich',name:'Sushi Sandwich',description:'2 Sizes',icon:'onigiri'},
  {id:'salad',name:'Salad',description:'Green, Arame, Wakame',icon:'leaf'},
  {id:'soba',name:'Soba Noodle',description:'',icon:'ramen'},
  {id:'senken',name:'Senken Cup',description:'Fish or Vegetarian',icon:'onigiri'},
  {id:'edamame',name:'Edamame',description:'Soybeans',icon:'leaf'},
  {id:'sashimi',name:'Sashimi',description:'Your choice',icon:'fish'},
  {id:'platter',name:'Sushi Platter',description:'Your choice',icon:'platter'},
];
export const BOARD_CELLS = CATEGORIES;
export const BINGO_LINES = [
  [0,1,2,3],[4,5,6,7],[8,9,10,11],[12,13,14,15],
  [0,4,8,12],[1,5,9,13],[2,6,10,14],[3,7,11,15],
  [0,5,10,15],[3,6,9,12],
];
export function getBingoStatus(stamps={}) {
  const completedLines=BINGO_LINES.filter(line=>line.every(index=>Boolean(stamps?.[BOARD_CELLS[index].id])));
  const count=CATEGORIES.filter(cell=>stamps?.[cell.id]).length,total=CATEGORIES.length,blackout=count===total;
  return {completedLines,hasBingo:completedLines.length>0,blackout,discount:blackout?25:completedLines.length?10:0,count,total};
}
export const BINGO_LINE_REWARDS = [
  ...Array.from({length:4},(_,index)=>({id:`line-row-${index+1}`,discount:10,label:`Row ${index+1}`})),
  ...Array.from({length:4},(_,index)=>({id:`line-column-${index+1}`,discount:10,label:`Column ${index+1}`})),
  {id:'line-diagonal-main',discount:10,label:'Main diagonal'},
  {id:'line-diagonal-anti',discount:10,label:'Other diagonal'},
];
export const BINGO_REWARDS = [
  ...BINGO_LINE_REWARDS,
  {id:'blackout',discount:25,label:'Full bingo card'},
];
// Older receipts did not record which line earned their one 10% reward. Keep
// their original identity for history and retries, but never issue this ID anew.
const previousLineReward={id:'first-line',discount:10,label:'Previous line reward'};
const rewardDefinition=id=>BINGO_REWARDS.find(reward=>reward.id===id)||(id===previousLineReward.id?previousLineReward:undefined);
const validDate=value=>typeof value==='string'&&!Number.isNaN(Date.parse(value));
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readRedemptions(entries){
  const result=[],usedIds=new Set(),usedRewards=new Set();let invalid=false;
  for(const entry of entries){
    if(!entry||typeof entry!=='object'||typeof entry.id!=='string'||!entry.id||entry.id.length>128||/[\u0000-\u001f\u007f]/.test(entry.id)){invalid=true;continue;}
    const definition=rewardDefinition(entry.rewardId),unknown=entry.rewardId==='legacy-unknown'&&entry.discount===null;
    if((!definition&&!unknown)||(definition&&entry.discount!==definition.discount)){invalid=true;continue;}
    const legacy=entry.legacy===true||unknown;
    if(!validDate(entry.date)&&!(legacy&&entry.date===null)){invalid=true;continue;}
    const id=uuid.test(entry.id)?entry.id.toLowerCase():entry.id;
    if(usedIds.has(id)||usedRewards.has(entry.rewardId))continue;
    usedIds.add(id);usedRewards.add(entry.rewardId);
    result.push({id,rewardId:entry.rewardId,discount:unknown?null:definition.discount,date:entry.date,actor:'owner',...(legacy?{legacy:true}:{})});
  }
  return {result,invalid};
}

// The private history survives old in-flight functions that recognize only the
// first-line and blackout IDs and rewrite the public redemption array. An empty
// history still allows an old function's first-ever redemption to be migrated.
export function getRedemptions(value){
  if(!value||typeof value!=='object')return [];
  if(value.rewardHistory!=null&&(!Array.isArray(value.rewardHistory)||value.rewardHistory.length>0)){
    const {result,invalid}=Array.isArray(value.rewardHistory)?readRedemptions(value.rewardHistory):{result:[],invalid:true};
    // A damaged private history must not silently reopen a possibly used coupon.
    if(invalid&&!result.some(entry=>entry.rewardId==='legacy-unknown')){
      let suffix=0,id='legacy-unknown-history';
      while(result.some(entry=>entry.id===id))id=`legacy-unknown-history-${++suffix}`;
      result.push({id,rewardId:'legacy-unknown',discount:null,date:null,actor:'owner',legacy:true});
    }
    return result;
  }
  const {result}=Array.isArray(value.redemptions)?readRedemptions(value.redemptions):{result:[]};
  if(result.length||value.redeemed!==true)return result;
  // Old cards stored only a redeemed flag and an optional percentage. Preserve
  // an unknown percentage as generic history rather than guessing a 10% reward.
  const discount=[10,25].includes(value.redeemedDiscount)?value.redeemedDiscount:null;
  const rewardId=discount===10?'first-line':discount===25?'blackout':'legacy-unknown';
  return [{id:`legacy-${rewardId==='legacy-unknown'?'unknown':rewardId}`,rewardId,discount,date:validDate(value.redeemedAt)?value.redeemedAt:null,actor:'owner',legacy:true}];
}

export function getRewardStatus(value){
  const redemptions=getRedemptions(value),bingo=getBingoStatus(value?.stamps);
  const legacyUnknown=redemptions.some(entry=>entry.rewardId==='legacy-unknown');
  const claimed=new Set(redemptions.map(entry=>entry.rewardId));
  const completedLines=new Set(bingo.completedLines);
  const legacyUsed=claimed.has('first-line')?1:0;
  // Reserve one currently eligible line for the old, unidentified 10% receipt.
  // This keeps its credit without guessing a historical line, and caps the card
  // at ten line rewards even after corrections or later stamp additions.
  const availableLines=legacyUnknown?[]:BINGO_LINE_REWARDS.filter((reward,index)=>!claimed.has(reward.id)&&completedLines.has(BINGO_LINES[index])).slice(legacyUsed);
  const availableRewards=availableLines.map(reward=>({...reward}));
  if(!legacyUnknown&&bingo.blackout&&!claimed.has('blackout'))availableRewards.push({...rewardDefinition('blackout')});
  const usedRewards=redemptions.map(entry=>({id:entry.rewardId,discount:entry.discount,label:rewardDefinition(entry.rewardId)?.label||'Previously redeemed reward',date:entry.date,redemptionId:entry.id,...(entry.legacy?{legacy:true}:{})}));
  const used=BINGO_LINE_REWARDS.filter(reward=>claimed.has(reward.id)).length+legacyUsed;
  const lines={total:BINGO_LINE_REWARDS.length,completed:bingo.completedLines.length,available:availableLines.length,used,legacyUsed};
  return {availableRewards,usedRewards,redemptions,legacyUnknown,count:redemptions.length,lines};
}

export function emptyPassport(){return {version:3,cardVersion:0,firstName:'',lastName:'',email:'',name:'',needsProfile:true,stamps:{},orders:[],redemptions:[],redeemed:false,redeemedDiscount:0};}
export function normalizePassport(value){
  const clean=emptyPassport();if(!value||typeof value!=='object')return clean;
  if(Number.isSafeInteger(value.cardVersion)&&value.cardVersion>=0)clean.cardVersion=value.cardVersion;
  for(const key of ['firstName','lastName'])if(typeof value[key]==='string')clean[key]=value[key].slice(0,60);
  if(typeof value.email==='string')clean.email=value.email.slice(0,254);
  clean.name=[clean.firstName,clean.lastName].filter(Boolean).join(' ')||(typeof value.name==='string'?value.name.slice(0,121):'');
  clean.needsProfile=value.needsProfile===true||!(clean.firstName&&clean.lastName&&clean.email);
  for(const category of CATEGORIES){const date=value.stamps?.[category.id];if(validDate(date))clean.stamps[category.id]=date;}
  clean.orders=Array.isArray(value.orders)?value.orders.filter(order=>order&&typeof order.id==='string'&&typeof order.date==='string').slice(0,50).map(order=>({id:order.id,date:order.date})):[];
  clean.redemptions=getRedemptions(value);
  clean.redeemed=clean.redemptions.length>0||value.redeemed===true;
  const latest=clean.redemptions.at(-1);
  clean.redeemedDiscount=clean.redeemed?(latest?latest.discount:[10,25].includes(value.redeemedDiscount)?value.redeemedDiscount:null):0;
  return clean;
}

// Explicit reward and operation identities prevent a retried confirmation from
// silently consuming another reward after its first response was lost.
export function redeemReward(value,rewardId,{requestId,date=new Date().toISOString()}={}){
  if(!rewardDefinition(rewardId))throw new Error('Choose which reward to redeem.');
  if(typeof requestId!=='string'||!uuid.test(requestId))throw new Error('A valid request ID is required to redeem a reward.');
  const id=requestId.toLowerCase(),next=normalizePassport(value);
  const previous=next.redemptions.find(entry=>entry.id===id);
  if(previous){
    if(previous.rewardId!==rewardId)throw new Error('This request ID was already used for a different reward.');
    return next;
  }
  if(rewardId==='first-line')throw new Error('Choose which reward to redeem.');
  const rewards=getRewardStatus(next);
  if(rewards.legacyUnknown||rewards.usedRewards.some(reward=>reward.id===rewardId))throw new Error('This reward has already been used.');
  const reward=rewards.availableRewards.find(entry=>entry.id===rewardId);
  if(!reward)throw new Error(rewardId==='blackout'?'Complete all sixteen food squares first.':'Complete a horizontal, vertical or diagonal line of four first.');
  if(!validDate(date))throw new Error('A valid redemption date is required.');
  next.redemptions.push({id,rewardId,discount:reward.discount,date,actor:'owner'});
  next.redeemed=true;next.redeemedDiscount=reward.discount;
  return next;
}
