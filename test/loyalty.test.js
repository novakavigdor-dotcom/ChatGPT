import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BOARD_CELLS,BINGO_LINES,CATEGORIES,getBingoStatus,emptyPassport,normalizePassport,redeemReward,getRedemptions,getRewardStatus} from '../src/loyalty.js';
import {createRequestId} from '../src/request-id.js';

const date='2026-10-19T12:00:00.000Z';
const stamps=ids=>Object.fromEntries(ids.map(id=>[id,date]));
const firstLine=()=>stamps(['maki','poke','gyoza','sushi-pizza']);
const fullCard=()=>stamps(CATEGORIES.map(category=>category.id));
const redeem=(value,rewardId,requestId=createRequestId())=>redeemReward(value,rewardId,{requestId,date});
const available=value=>getRewardStatus(value).availableRewards.map(reward=>reward.id);

test('4x4 board follows all sixteen food squares from the PDF with no free square',()=>{
  assert.equal(CATEGORIES.length,16);assert.equal(BOARD_CELLS.length,16);
  assert.equal(BOARD_CELLS.some(cell=>cell.free),false);
  assert.equal(getBingoStatus({}).discount,0);assert.equal(getBingoStatus({free:date}).count,0);
  assert.deepEqual(BOARD_CELLS.slice(0,4).map(cell=>cell.id),['maki','poke','gyoza','sushi-pizza']);
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

test('the first line gives one ten percent reward, not a reward for every later line',()=>{
  const card={...emptyPassport(),stamps:firstLine()};
  assert.deepEqual(available(card),['first-line']);
  const used=redeem(card,'first-line');
  assert.equal(used.redemptions.length,1);assert.equal(used.redemptions[0].discount,10);
  used.stamps={...used.stamps,...stamps(['handroll','onigiri','udon','miso'])};
  assert.deepEqual(available(used),[]);
  assert.throws(()=>redeem(used,'first-line'),/already been used/);
});

test('customers can redeem ten percent for a line and later twenty five percent for the full card',()=>{
  const first=redeem({...emptyPassport(),stamps:firstLine()},'first-line');
  first.stamps=fullCard();
  assert.deepEqual(available(first),['blackout']);
  const second=redeem(first,'blackout');
  assert.deepEqual(second.redemptions.map(entry=>entry.discount),[10,25]);
  assert.deepEqual(available(second),[]);
  assert.equal(second.redeemed,true);assert.equal(second.redeemedDiscount,25);
  assert.throws(()=>redeem(second,'blackout'),/already been used/);
  assert.throws(()=>redeem(second,'first-line'),/already been used/);
});

test('a full-card redemption does not consume an unused first-line reward',()=>{
  const card={...emptyPassport(),stamps:fullCard()};
  assert.deepEqual(available(card),['first-line','blackout']);
  const first=redeem(card,'blackout');
  assert.deepEqual(available(first),['first-line']);
  const second=redeem(first,'first-line');
  assert.deepEqual(second.redemptions.map(entry=>entry.discount),[25,10]);
  assert.deepEqual(available(second),[]);
});

test('repeat confirmation keeps its original reward and cannot consume the other one',()=>{
  const requestId=createRequestId(),card={...emptyPassport(),stamps:fullCard()};
  const used=redeem(card,'first-line',requestId);
  const repeated=redeem(used,'first-line',requestId.toUpperCase());
  assert.deepEqual(repeated,used);
  assert.deepEqual(available(repeated),['blackout']);
  assert.throws(()=>redeem(used,'blackout',requestId),/different reward/);
  assert.equal(card.redemptions.length,0);
});

test('redemption requires an explicit eligible reward and valid operation identity',()=>{
  const card={...emptyPassport(),stamps:firstLine()};
  assert.throws(()=>redeemReward(card),/Choose which reward/);
  assert.throws(()=>redeemReward(card,'first-line'),/valid request ID/);
  assert.throws(()=>redeemReward(card,'first-line',{requestId:'bad-id'}),/valid request ID/);
  assert.throws(()=>redeem(card,'blackout'),/Complete all sixteen/);
  assert.throws(()=>redeem(emptyPassport(),'first-line'),/Complete/);
  assert.throws(()=>redeemReward(card,'first-line',{requestId:createRequestId(),date:'invalid'}),/valid redemption date/);
});

test('corrections remove current eligibility without resetting used rewards after a later restamp',()=>{
  const card={...emptyPassport(),stamps:firstLine()};
  delete card.stamps.gyoza;
  assert.deepEqual(available(card),[]);
  card.stamps.gyoza=date;
  const used=redeem(card,'first-line');
  const history=structuredClone(used.redemptions);
  delete used.stamps.gyoza;
  assert.equal(getBingoStatus(used.stamps).discount,0);
  assert.deepEqual(available(used),[]);
  used.stamps.gyoza=date;
  assert.deepEqual(used.redemptions,history);assert.deepEqual(available(used),[]);
  used.stamps=fullCard();assert.deepEqual(available(used),['blackout']);
});

test('legacy known ten percent redemption consumes only the first-line reward',()=>{
  const legacy={redeemed:true,redeemedDiscount:10,redeemedAt:date,stamps:fullCard()};
  assert.deepEqual(available(legacy),['blackout']);
  assert.equal(getRedemptions(legacy)[0].rewardId,'first-line');
  assert.equal(getRedemptions(legacy)[0].date,date);
  const updated=redeem(legacy,'blackout');
  assert.deepEqual(updated.redemptions.map(entry=>entry.discount),[10,25]);
});

test('legacy known twenty five percent redemption leaves the first-line reward unused',()=>{
  const legacy={redeemed:true,redeemedDiscount:25,stamps:fullCard()};
  assert.deepEqual(available(legacy),['first-line']);
  assert.equal(getRedemptions(legacy)[0].date,null);
  assert.deepEqual(redeem(legacy,'first-line').redemptions.map(entry=>entry.discount),[25,10]);
});

test('an empty new ledger cannot reopen an old redeemed reward',()=>{
  const mixed={...emptyPassport(),stamps:fullCard(),redeemed:true,redeemedDiscount:10};
  assert.deepEqual(available(mixed),['blackout']);
  assert.equal(getRedemptions(mixed).length,1);
  assert.throws(()=>redeem(mixed,'first-line'),/already been used/);
});

test('nonempty permanent ledger is authoritative over compatibility fields',()=>{
  const used=redeem({...emptyPassport(),stamps:fullCard()},'first-line');
  used.redeemed=true;used.redeemedDiscount=25;
  assert.deepEqual(available(used),['blackout']);
  assert.equal(normalizePassport(used).redeemedDiscount,10);
});

test('unknown legacy reward stays generic and conservatively reserves both reward types',()=>{
  for(const redeemedDiscount of [null,undefined,0,15]){
    const legacy={redeemed:true,redeemedDiscount,stamps:fullCard()};
    const customer=normalizePassport(legacy),status=getRewardStatus(customer);
    assert.equal(customer.redeemed,true);assert.equal(customer.redeemedDiscount,null);
    assert.equal(customer.redemptions.length,1);assert.equal(status.legacyUnknown,true);
    assert.deepEqual(status.availableRewards,[]);
    assert.equal(status.usedRewards.length,1);assert.equal(status.usedRewards[0].discount,null);
    assert.equal(status.usedRewards[0].label,'Previously redeemed reward');
    assert.throws(()=>redeem(customer,'blackout'),/already been used/);
  }
});

test('history normalization rejects malformed entries and deduplicates operation and reward identities',()=>{
  const valid=redeem({...emptyPassport(),stamps:fullCard()},'first-line').redemptions[0];
  const value={redemptions:[null,{},valid,{...valid,id:createRequestId()},{...valid,rewardId:'blackout',discount:25},{...valid,id:createRequestId(),rewardId:'blackout',discount:10},{...valid,id:createRequestId(),rewardId:'blackout',discount:25,date:'invalid'}]};
  assert.deepEqual(getRedemptions(value),[valid]);
  assert.deepEqual(available({...value,stamps:fullCard()}),['blackout']);
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
