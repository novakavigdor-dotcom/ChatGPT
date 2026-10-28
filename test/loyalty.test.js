import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BOARD_CELLS,BINGO_LINES,BINGO_LINE_REWARDS,BINGO_REWARDS,CATEGORIES,getBingoStatus,emptyPassport,normalizePassport,redeemReward,getRedemptions,getRewardStatus} from '../src/loyalty.js';
import {createRequestId} from '../src/request-id.js';

const date='2026-10-19T12:00:00.000Z';
const stamps=ids=>Object.fromEntries(ids.map(id=>[id,date]));
const firstLine=()=>stamps(['maki','poke','gyoza','sushi-pizza']);
const fullCard=()=>stamps(CATEGORIES.map(category=>category.id));
const redeem=(value,rewardId,requestId=createRequestId())=>redeemReward(value,rewardId,{requestId,date});
const available=value=>getRewardStatus(value).availableRewards.map(reward=>reward.id);

test('4x4 board keeps all sixteen food squares and the renamed Sushi Burrito stamp history',()=>{
  assert.equal(CATEGORIES.length,16);assert.equal(BOARD_CELLS.length,16);
  assert.equal(BOARD_CELLS.some(cell=>cell.free),false);
  assert.equal(getBingoStatus({}).discount,0);assert.equal(getBingoStatus({free:date}).count,0);
  assert.deepEqual(BOARD_CELLS.slice(0,4).map(cell=>cell.id),['maki','poke','gyoza','sushi-pizza']);
  assert.equal(BOARD_CELLS[8].name,'Sushi Burrito');
  assert.equal(BOARD_CELLS[8].id,'nigiri');
  const existingCard=normalizePassport({version:3,stamps:stamps(['nigiri','sandwich','salad','soba'])});
  assert.equal(existingCard.stamps.nigiri,date);
  assert.deepEqual(available(existingCard),['line-row-3']);
  const used=normalizePassport(redeem(existingCard,'line-row-3'));
  assert.equal(used.stamps.nigiri,date);
  assert.deepEqual(available(used),[]);
  assert.equal(getRewardStatus(used).usedRewards[0].id,'line-row-3');
});

test('card versions survive normalization and reward updates after a reset',()=>{
  assert.equal(normalizePassport({}).cardVersion,0);
  assert.equal(normalizePassport({cardVersion:2}).cardVersion,2);
  assert.equal(normalizePassport({cardVersion:-1}).cardVersion,0);
  const next=redeem({...emptyPassport(),cardVersion:2,stamps:firstLine()},'line-row-1');
  assert.equal(next.cardVersion,2);
});

test('all four rows, four columns and two diagonals require four stamps for ten percent',()=>{
  assert.equal(BINGO_LINES.length,10);
  for(const line of BINGO_LINES){
    assert.equal(line.length,4);
    const ids=line.map(index=>BOARD_CELLS[index].id),result=getBingoStatus(stamps(ids));
    assert.equal(result.discount,10);
    assert.ok(result.completedLines.some(value=>value.join(',')===line.join(',')));
    assert.equal(getBingoStatus(stamps(ids.slice(0,3))).hasBingo,false);
  }
});

test('three old top-row stamps do not count as a bingo on the new card',()=>{
  assert.equal(getBingoStatus(stamps(['maki','poke','gyoza'])).hasBingo,false);
});

test('full card requires all sixteen items and gives twenty five percent',()=>{
  const all=fullCard();
  assert.equal(getBingoStatus(all).discount,25);assert.equal(getBingoStatus(all).completedLines.length,10);
  for(const category of CATEGORIES){
    const partial={...all};delete partial[category.id];
    assert.equal(getBingoStatus(partial).blackout,false);assert.equal(getBingoStatus(partial).discount,10);
  }
});

test('each named row, column and diagonal independently earns one ten percent reward',()=>{
  assert.equal(BINGO_LINE_REWARDS.length,10);assert.equal(BINGO_REWARDS.length,11);
  assert.deepEqual(BINGO_LINE_REWARDS.map(reward=>reward.id),[
    'line-row-1','line-row-2','line-row-3','line-row-4',
    'line-column-1','line-column-2','line-column-3','line-column-4',
    'line-diagonal-main','line-diagonal-anti',
  ]);
  assert.deepEqual(BINGO_LINE_REWARDS.map(reward=>reward.label),[
    'Row 1','Row 2','Row 3','Row 4','Column 1','Column 2','Column 3','Column 4','Main diagonal','Other diagonal',
  ]);
  for(const [index,reward] of BINGO_LINE_REWARDS.entries()){
    const card={...emptyPassport(),stamps:stamps(BINGO_LINES[index].map(cell=>BOARD_CELLS[cell].id))};
    assert.deepEqual(available(card),[reward.id]);
    const used=redeem(card,reward.id),status=getRewardStatus(used);
    assert.equal(used.redemptions[0].discount,10);
    assert.equal(status.usedRewards[0].label,reward.label);
    assert.deepEqual(status.lines,{total:10,completed:1,available:0,used:1,legacyUsed:0});
    assert.throws(()=>redeem(used,reward.id),/already been used/);
  }
});

test('one new stamp can complete multiple independently redeemable lines',()=>{
  const ids=[...new Set([...BINGO_LINES[0],...BINGO_LINES[4]])].map(index=>BOARD_CELLS[index].id);
  const card={...emptyPassport(),stamps:stamps(ids)};
  delete card.stamps.maki;
  assert.deepEqual(available(card),[]);
  card.stamps.maki=date;
  assert.deepEqual(available(card),['line-row-1','line-column-1']);
  const first=redeem(card,'line-row-1');
  assert.deepEqual(available(first),['line-column-1']);
  assert.deepEqual(available(redeem(first,'line-column-1')),[]);
});

test('a completed later row earns a fresh ten percent reward',()=>{
  const first=redeem({...emptyPassport(),stamps:firstLine()},'line-row-1');
  first.stamps={...first.stamps,...stamps(['handroll','onigiri','udon','miso'])};
  assert.deepEqual(available(first),['line-row-2']);
  const second=redeem(first,'line-row-2');
  assert.deepEqual(second.redemptions.map(entry=>entry.rewardId),['line-row-1','line-row-2']);
  assert.deepEqual(available(second),[]);
});

test('all ten line rewards and the separate blackout reward can be used once each',()=>{
  let card={...emptyPassport(),stamps:fullCard()};
  const rewardIds=BINGO_REWARDS.map(reward=>reward.id);
  assert.deepEqual(available(card),rewardIds);
  for(const [index,rewardId] of rewardIds.entries()){
    card=redeem(card,rewardId);
    assert.equal(card.redemptions.length,index+1);
    assert.equal(card.redemptions.at(-1).rewardId,rewardId);
    assert.throws(()=>redeem(card,rewardId),/already been used/);
  }
  assert.deepEqual(card.redemptions.map(entry=>entry.discount),[...Array(10).fill(10),25]);
  assert.deepEqual(available(card),[]);
  assert.equal(card.redeemed,true);assert.equal(card.redeemedDiscount,25);
  assert.deepEqual(getRewardStatus(card).lines,{total:10,completed:10,available:0,used:10,legacyUsed:0});
});

test('a full-card redemption does not consume unused line rewards',()=>{
  const card=redeem({...emptyPassport(),stamps:fullCard()},'blackout');
  assert.deepEqual(available(card),BINGO_LINE_REWARDS.map(reward=>reward.id));
  assert.deepEqual(card.redemptions.map(entry=>entry.discount),[25]);
  assert.equal(getRewardStatus(card).lines.used,0);
});

test('repeat confirmation keeps its original line and cannot consume another reward',()=>{
  const requestId=createRequestId(),card={...emptyPassport(),stamps:fullCard()};
  const used=redeem(card,'line-row-1',requestId);
  const repeated=redeem(used,'line-row-1',requestId.toUpperCase());
  assert.deepEqual(repeated,used);
  assert.deepEqual(available(repeated),BINGO_REWARDS.slice(1).map(reward=>reward.id));
  assert.throws(()=>redeem(used,'line-row-2',requestId),/different reward/);
  assert.throws(()=>redeem(used,'blackout',requestId),/different reward/);
  assert.equal(card.redemptions.length,0);
});

test('redemption requires an explicit named eligible reward and valid operation identity',()=>{
  const card={...emptyPassport(),stamps:firstLine()};
  assert.throws(()=>redeemReward(card),/Choose which reward/);
  assert.throws(()=>redeem(card,'first-line'),/Choose which reward/);
  assert.throws(()=>redeem(card,'line-row-5'),/Choose which reward/);
  assert.throws(()=>redeemReward(card,'line-row-1'),/valid request ID/);
  assert.throws(()=>redeemReward(card,'line-row-1',{requestId:'bad-id'}),/valid request ID/);
  assert.throws(()=>redeem(card,'blackout'),/Complete all sixteen/);
  assert.throws(()=>redeem(card,'line-row-2'),/Complete/);
  assert.throws(()=>redeem(emptyPassport(),'line-row-1'),/Complete/);
  assert.throws(()=>redeemReward(card,'line-row-1',{requestId:createRequestId(),date:'invalid'}),/valid redemption date/);
});

test('corrections and later restamps never reopen a redeemed line or blackout',()=>{
  const card={...emptyPassport(),stamps:firstLine()};
  delete card.stamps.gyoza;
  assert.deepEqual(available(card),[]);
  card.stamps.gyoza=date;
  let used=redeem(card,'line-row-1');
  const history=structuredClone(used.redemptions);
  delete used.stamps.gyoza;
  assert.equal(getBingoStatus(used.stamps).discount,0);
  assert.deepEqual(available(used),[]);
  used.stamps.gyoza=date;
  assert.deepEqual(used.redemptions,history);assert.deepEqual(available(used),[]);
  used.stamps=fullCard();used=redeem(used,'blackout');
  const fullHistory=structuredClone(used.redemptions);
  used.stamps={};assert.deepEqual(available(used),[]);
  used.stamps=fullCard();
  assert.deepEqual(used.redemptions,fullHistory);
  assert.deepEqual(available(used),BINGO_LINE_REWARDS.slice(1).map(reward=>reward.id));
  assert.throws(()=>redeem(used,'line-row-1'),/already been used/);
  assert.throws(()=>redeem(used,'blackout'),/already been used/);
});

test('legacy known ten percent reserves one unidentified line credit and leaves nine new line rewards',()=>{
  const legacy={redeemed:true,redeemedDiscount:10,redeemedAt:date,stamps:fullCard()};
  assert.deepEqual(available(legacy),[...BINGO_LINE_REWARDS.slice(1).map(reward=>reward.id),'blackout']);
  assert.deepEqual(getRewardStatus(legacy).lines,{total:10,completed:10,available:9,used:1,legacyUsed:1});
  const receipt=getRedemptions(legacy)[0];
  assert.equal(receipt.rewardId,'first-line');assert.equal(receipt.date,date);
  assert.equal(getRewardStatus(legacy).usedRewards[0].label,'Previous line reward');
  let updated=normalizePassport(legacy);
  for(const reward of BINGO_LINE_REWARDS.slice(1))updated=redeem(updated,reward.id);
  assert.deepEqual(available(updated),['blackout']);
  updated=redeem(updated,'blackout');
  assert.equal(updated.redemptions.filter(entry=>entry.discount===10).length,10);
  assert.deepEqual(updated.redemptions[0],receipt);
  assert.equal(getRewardStatus(updated).lines.used,10);
  assert.deepEqual(available(updated),[]);
  assert.throws(()=>redeem(updated,'line-row-1'),/Complete/);
});

test('legacy line credit reserves current eligibility without inventing an old line identity',()=>{
  let card=normalizePassport({redeemed:true,redeemedDiscount:10,redeemedAt:date,stamps:firstLine()});
  const legacyReceipt=structuredClone(card.redemptions[0]);
  assert.deepEqual(available(card),[]);
  card.stamps={...card.stamps,...stamps(['handroll','onigiri','udon','miso'])};
  assert.deepEqual(available(card),['line-row-2']);
  card=redeem(card,'line-row-2');
  card.stamps={};assert.deepEqual(available(card),[]);
  card.stamps=stamps(['nigiri','sandwich','salad','soba']);
  assert.deepEqual(available(card),[]);
  card.stamps=fullCard();
  assert.equal(getRewardStatus(card).lines.available,8);
  assert.equal(available(card).includes('line-row-2'),false);
  assert.deepEqual(card.redemptions[0],legacyReceipt);
});

test('existing first-line receipt retries retain their original identity but new first-line requests are rejected',()=>{
  const id=createRequestId();
  const receipt={id,rewardId:'first-line',discount:10,date,actor:'owner'};
  const card={...emptyPassport(),stamps:fullCard(),redemptions:[receipt],redeemed:true,redeemedDiscount:10};
  const repeated=redeem(card,'first-line',id.toUpperCase());
  assert.deepEqual(repeated.redemptions,[receipt]);
  assert.throws(()=>redeem(card,'first-line'),/Choose which reward/);
  assert.throws(()=>redeem(card,'line-row-2',id),/different reward/);
  assert.equal(getRewardStatus(repeated).lines.available,9);
});

test('legacy known twenty five percent consumes only blackout and leaves all ten line rewards',()=>{
  const legacy={redeemed:true,redeemedDiscount:25,stamps:fullCard()};
  assert.deepEqual(available(legacy),BINGO_LINE_REWARDS.map(reward=>reward.id));
  assert.equal(getRedemptions(legacy)[0].date,null);
  assert.deepEqual(getRewardStatus(legacy).lines,{total:10,completed:10,available:10,used:0,legacyUsed:0});
  assert.deepEqual(redeem(legacy,'line-row-1').redemptions.map(entry=>entry.discount),[25,10]);
  assert.throws(()=>redeem(legacy,'blackout'),/already been used/);
});

test('an empty new ledger cannot reopen an old redeemed reward',()=>{
  const mixed={...emptyPassport(),stamps:fullCard(),redeemed:true,redeemedDiscount:10};
  assert.deepEqual(available(mixed),[...BINGO_LINE_REWARDS.slice(1).map(reward=>reward.id),'blackout']);
  assert.equal(getRedemptions(mixed).length,1);
  assert.throws(()=>redeem(mixed,'first-line'),/Choose which reward/);
});

test('nonempty valid permanent ledger is authoritative over compatibility fields',()=>{
  const used=redeem({...emptyPassport(),stamps:fullCard()},'line-row-1');
  used.redeemed=true;used.redeemedDiscount=25;
  assert.deepEqual(available(used),BINGO_REWARDS.slice(1).map(reward=>reward.id));
  assert.equal(normalizePassport(used).redeemedDiscount,10);
  assert.equal(getRewardStatus(used).lines.legacyUsed,0);
});

test('private history survives old functions rewriting named redemptions to first-line or an empty ledger',()=>{
  const requestId=createRequestId(),used=redeem({...emptyPassport(),stamps:fullCard()},'line-row-1',requestId);
  const rewardHistory=structuredClone(used.redemptions);
  const oldReceipt={id:'legacy-first-line',rewardId:'first-line',discount:10,date:null,actor:'owner',legacy:true};
  for(const redemptions of [[],[oldReceipt]]){
    const rewritten={...used,redemptions,rewardHistory};
    assert.deepEqual(getRedemptions(rewritten),rewardHistory);
    assert.deepEqual(available(rewritten),BINGO_REWARDS.slice(1).map(reward=>reward.id));
    assert.equal(getRewardStatus(rewritten).lines.legacyUsed,0);
    const normalized=normalizePassport(rewritten);
    assert.deepEqual(normalized.redemptions,rewardHistory);
    assert.equal(Object.hasOwn(normalized,'rewardHistory'),false);
    assert.equal(normalized.version,3);
    assert.deepEqual(redeem(rewritten,'line-row-1',requestId),normalized);
    assert.throws(()=>redeem(rewritten,'line-row-1'),/already been used/);
  }
});

test('empty private history still migrates a genuine old first-line redemption',()=>{
  const receipt={id:createRequestId(),rewardId:'first-line',discount:10,date,actor:'owner'};
  const oldCard={...emptyPassport(),stamps:fullCard(),redemptions:[receipt],rewardHistory:[],redeemed:true,redeemedDiscount:10};
  assert.deepEqual(getRedemptions(oldCard),[receipt]);
  assert.equal(getRewardStatus(oldCard).lines.available,9);
  assert.deepEqual(redeem(oldCard,'first-line',receipt.id).redemptions,[receipt]);
  const flagOnly={...oldCard,redemptions:[],redeemedAt:date};
  assert.equal(getRedemptions(flagOnly)[0].rewardId,'first-line');
  assert.equal(getRedemptions(flagOnly)[0].date,date);
  assert.equal(getRewardStatus(flagOnly).lines.available,9);
});

test('nonempty private history keeps receipt identities and wins over conflicting public fields',()=>{
  let used=redeem({...emptyPassport(),stamps:fullCard()},'line-column-3');
  used=redeem(used,'blackout');
  const rewardHistory=structuredClone(used.redemptions);
  const stale={...used,redemptions:[],rewardHistory,redeemed:false,redeemedDiscount:0};
  assert.deepEqual(getRedemptions(stale),rewardHistory);
  assert.deepEqual(normalizePassport(stale).redemptions,rewardHistory);
  assert.equal(normalizePassport(stale).redeemed,true);
  for(const receipt of rewardHistory){
    assert.deepEqual(redeem(stale,receipt.rewardId,receipt.id).redemptions,rewardHistory);
  }
  assert.equal(available(stale).includes('line-column-3'),false);
  assert.equal(available(stale).includes('blackout'),false);
});

test('corrupted private history preserves valid receipts and blocks uncertain rewards without guessing a percentage',()=>{
  const receipt=redeem({...emptyPassport(),stamps:fullCard()},'line-row-1').redemptions[0];
  for(const rewardHistory of [{},'invalid',[null],[{...receipt,discount:25}],[receipt,null]]){
    const card={...emptyPassport(),stamps:fullCard(),rewardHistory};
    const history=getRedemptions(card),status=getRewardStatus(card);
    assert.equal(status.legacyUnknown,true);
    assert.deepEqual(status.availableRewards,[]);
    assert.equal(history.at(-1).discount,null);
    assert.equal(history.at(-1).rewardId,'legacy-unknown');
    if(Array.isArray(rewardHistory)&&rewardHistory.includes(receipt))assert.deepEqual(history[0],receipt);
    assert.deepEqual(getRedemptions({...card,rewardHistory:history}),history);
    assert.throws(()=>redeem(card,'line-row-2'),/already been used/);
  }
});

test('unknown legacy reward stays generic and conservatively blocks all rewards',()=>{
  for(const redeemedDiscount of [null,undefined,0,15]){
    const legacy={redeemed:true,redeemedDiscount,stamps:fullCard()};
    const customer=normalizePassport(legacy),status=getRewardStatus(customer);
    assert.equal(customer.redeemed,true);assert.equal(customer.redeemedDiscount,null);
    assert.equal(customer.redemptions.length,1);assert.equal(status.legacyUnknown,true);
    assert.deepEqual(status.availableRewards,[]);assert.equal(status.lines.available,0);
    assert.equal(status.usedRewards.length,1);assert.equal(status.usedRewards[0].discount,null);
    assert.equal(status.usedRewards[0].label,'Previously redeemed reward');
    assert.throws(()=>redeem(customer,'blackout'),/already been used/);
    assert.throws(()=>redeem(customer,'line-row-1'),/already been used/);
  }
});

test('history normalization rejects malformed entries and deduplicates operation and named reward identities',()=>{
  const valid=redeem({...emptyPassport(),stamps:fullCard()},'line-row-1').redemptions[0];
  const value={redemptions:[null,{},valid,{...valid,id:createRequestId()},{...valid,rewardId:'blackout',discount:25},{...valid,id:createRequestId(),rewardId:'blackout',discount:10},{...valid,id:createRequestId(),rewardId:'blackout',discount:25,date:'invalid'}]};
  assert.deepEqual(getRedemptions(value),[valid]);
  assert.deepEqual(available({...value,stamps:fullCard()}),BINGO_REWARDS.slice(1).map(reward=>reward.id));
  assert.equal(getRewardStatus(null).count,0);
});

test('account normalization preserves identity and history while dropping invalid or obsolete active stamps',()=>{
  const account=normalizePassport({firstName:'Avigdor',lastName:'Novak',email:'a@example.com',stamps:{maki:date,noodles:date,udon:'invalid'},redeemed:true,redeemedDiscount:10});
  assert.equal(account.name,'Avigdor Novak');assert.equal(account.needsProfile,false);
  assert.deepEqual(account.stamps,{maki:date});assert.equal(account.redeemedDiscount,10);
  assert.equal(account.redemptions[0].rewardId,'first-line');
  assert.deepEqual(normalizePassport(null),emptyPassport());
});

test('server-required profile completion remains authoritative for a complete-looking legacy profile',()=>{
  const customer=normalizePassport({firstName:'Alice',lastName:'Sato',email:'alice@example.test',needsProfile:true});
  assert.equal(customer.needsProfile,true);
  assert.equal(normalizePassport({...customer,needsProfile:false}).needsProfile,false);
});
