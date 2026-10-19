export const CATEGORIES = [
  {id:'maki',name:'Maki',description:'any sushi roll',icon:'maki'},
  {id:'poke',name:'Poke bowl',description:'build your favourite',icon:'onigiri'},
  {id:'noodles',name:'Noodles',description:'udon or soba',icon:'ramen'},
  {id:'ramen',name:'Ramen',description:'miso bowl',icon:'ramen'},
  {id:'platter',name:'Platter',description:'family or event order',icon:'platter'},
  {id:'onigiri',name:'Onigiri',description:'vegetarian or fish',icon:'onigiri'},
  {id:'gyoza',name:'Gyoza',description:'salmon or vegetarian',icon:'platter'},
  {id:'burrito',name:'Burrito',description:'choice of type',icon:'maki'},
];
export const BOARD_CELLS = [...CATEGORIES.slice(0,4),{id:'free',name:'Umami Sushi',description:'Free space',free:true},...CATEGORIES.slice(4)];
export const BINGO_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
export function getBingoStatus(stamps={}) {
  const filled=BOARD_CELLS.map(cell=>cell.free||Boolean(stamps?.[cell.id]));
  const completedLines=BINGO_LINES.filter(line=>line.every(index=>filled[index]));
  const count=CATEGORIES.filter(cell=>stamps?.[cell.id]).length;
  const blackout=count===8;
  return {completedLines,hasBingo:completedLines.length>0,blackout,discount:blackout?25:completedLines.length?10:0,count};
}
export function emptyPassport(){return {version:2,firstName:'',lastName:'',email:'',name:'',needsProfile:true,stamps:{},orders:[],redeemed:false,redeemedDiscount:0};}
export function normalizePassport(value){
  const clean=emptyPassport();if(!value||typeof value!=='object')return clean;
  for(const key of ['firstName','lastName'])if(typeof value[key]==='string')clean[key]=value[key].slice(0,60);
  if(typeof value.email==='string')clean.email=value.email.slice(0,254);
  clean.name=[clean.firstName,clean.lastName].filter(Boolean).join(' ')||(typeof value.name==='string'?value.name.slice(0,121):'');
  clean.needsProfile=!(clean.firstName&&clean.lastName&&clean.email);
  for(const category of CATEGORIES){const date=value.stamps?.[category.id];if(typeof date==='string'&&!Number.isNaN(Date.parse(date)))clean.stamps[category.id]=date;}
  clean.orders=Array.isArray(value.orders)?value.orders.filter(order=>order&&typeof order.id==='string'&&typeof order.date==='string').slice(0,50).map(order=>({id:order.id,date:order.date})):[];
  clean.redeemed=value.redeemed===true;
  clean.redeemedDiscount=clean.redeemed&&[10,25].includes(value.redeemedDiscount)?value.redeemedDiscount:0;
  return clean;
}
export function redeemReward(value){
  const next=normalizePassport(value),status=getBingoStatus(next.stamps);
  if(next.redeemed)throw new Error('The one reward for this card has already been used.');
  if(!status.discount)throw new Error('Complete a horizontal, vertical or diagonal line first.');
  next.redeemed=true;next.redeemedDiscount=status.discount;return next;
}
