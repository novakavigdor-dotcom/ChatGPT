export const CATEGORIES = [
  {id:'maki',name:'Maki',description:'Your Choice',icon:'maki'},
  {id:'poke',name:'Poke Bowl',description:'Build your own',icon:'onigiri'},
  {id:'gyoza',name:'Gyoza',description:'Salmon or Vegetarian',icon:'platter'},
  {id:'sushi-pizza',name:'Sushi Pizza',description:'4 Choices',icon:'platter'},
  {id:'handroll',name:'Handroll',description:'Your Choice',icon:'maki'},
  {id:'onigiri',name:'Onigiri',description:'3 Options',icon:'onigiri'},
  {id:'udon',name:'Udon Noodle',description:'3 Options',icon:'ramen'},
  {id:'miso',name:'Miso Soup',description:'',icon:'ramen'},
  {id:'nigiri',name:'Nigiri',description:'Your choice',icon:'maki'},
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
export function emptyPassport(){return {version:3,firstName:'',lastName:'',email:'',name:'',needsProfile:true,stamps:{},orders:[],redeemed:false,redeemedDiscount:0};}
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
  if(!status.discount)throw new Error('Complete a horizontal, vertical or diagonal line of four first.');
  next.redeemed=true;next.redeemedDiscount=status.discount;return next;
}
