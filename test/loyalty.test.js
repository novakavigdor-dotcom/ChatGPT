import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BOARD_CELLS,BINGO_LINES,CATEGORIES,getBingoStatus,emptyPassport,normalizePassport,redeemReward} from '../src/loyalty.js';
const date='2026-10-19T12:00:00.000Z';
const stamps=ids=>Object.fromEntries(ids.map(id=>[id,date]));
test('4x4 board follows all sixteen food squares from the PDF with no free square',()=>{assert.equal(CATEGORIES.length,16);assert.equal(BOARD_CELLS.length,16);assert.equal(BOARD_CELLS.some(cell=>cell.free),false);assert.equal(getBingoStatus({}).discount,0);assert.equal(getBingoStatus({free:date}).count,0);assert.deepEqual(BOARD_CELLS.slice(0,4).map(c=>c.id),['maki','poke','gyoza','sushi-pizza']);});
test('all four rows, four columns and two diagonals require four stamps for ten percent',()=>{assert.equal(BINGO_LINES.length,10);for(const line of BINGO_LINES){assert.equal(line.length,4);const ids=line.map(index=>BOARD_CELLS[index].id),result=getBingoStatus(stamps(ids));assert.equal(result.discount,10);assert.ok(result.completedLines.some(value=>value.join(',')===line.join(',')));assert.equal(getBingoStatus(stamps(ids.slice(0,3))).hasBingo,false);}});
test('three old top-row stamps no longer count as a bingo on the new card',()=>assert.equal(getBingoStatus(stamps(['maki','poke','gyoza'])).hasBingo,false));
test('full card requires all sixteen items and gives twenty five percent',()=>{const all=stamps(CATEGORIES.map(c=>c.id));assert.equal(getBingoStatus(all).discount,25);assert.equal(getBingoStatus(all).completedLines.length,10);for(const c of CATEGORIES){const partial={...all};delete partial[c.id];assert.equal(getBingoStatus(partial).blackout,false);assert.equal(getBingoStatus(partial).discount,10);}});
test('removing one mistaken stamp immediately removes a lone bingo',()=>{const card=stamps(['maki','poke','gyoza','sushi-pizza']);assert.equal(getBingoStatus(card).discount,10);delete card.gyoza;assert.equal(getBingoStatus(card).discount,0);});
test('one reward remains used after later stamps or corrections',()=>{const first=redeemReward({...emptyPassport(),stamps:stamps(['maki','poke','gyoza','sushi-pizza'])});assert.equal(first.redeemedDiscount,10);first.stamps=stamps(CATEGORIES.map(c=>c.id));assert.throws(()=>redeemReward(first),/already been used/);delete first.stamps.maki;assert.equal(normalizePassport(first).redeemed,true);});
test('a full card can be redeemed once for twenty five percent',()=>{const result=redeemReward({...emptyPassport(),stamps:stamps(CATEGORIES.map(c=>c.id))});assert.equal(result.redeemedDiscount,25);assert.equal(result.redeemed,true);assert.throws(()=>redeemReward(emptyPassport()),/Complete/);});
test('account normalization preserves identity fields and drops invalid or obsolete active stamps',()=>{const account=normalizePassport({firstName:'Avigdor',lastName:'Novak',email:'a@example.com',stamps:{maki:date,noodles:date,udon:'invalid'},redeemed:true,redeemedDiscount:10});assert.equal(account.name,'Avigdor Novak');assert.equal(account.needsProfile,false);assert.deepEqual(account.stamps,{maki:date});assert.equal(account.redeemedDiscount,10);assert.deepEqual(normalizePassport(null),emptyPassport());});

test('server-required profile completion remains authoritative for a complete-looking legacy profile',()=>{
  const customer=normalizePassport({firstName:'Alice',lastName:'Sato',email:'alice@example.test',needsProfile:true});
  assert.equal(customer.needsProfile,true);
  assert.equal(normalizePassport({...customer,needsProfile:false}).needsProfile,false);
});
test('unknown historical reward percentages remain unknown instead of becoming ten percent',()=>{
  for(const redeemedDiscount of [null,undefined,0,15]){
    const customer=normalizePassport({redeemed:true,redeemedDiscount});
    assert.equal(customer.redeemed,true);
    assert.equal(customer.redeemedDiscount,null);
  }
  assert.equal(normalizePassport({redeemed:true,redeemedDiscount:25}).redeemedDiscount,25);
});
