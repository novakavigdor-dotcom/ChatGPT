export const CATEGORIES = [
  {id:'maki',name:'Maki',description:'Any sushi roll',note:'A classic place to start.',icon:'maki',color:'rose'},
  {id:'rice',name:'Poke or onigiri',description:'Bowl or rice snack',note:'Little bites. Big discoveries.',icon:'onigiri',color:'sage'},
  {id:'noodles',name:'Noodles or soup',description:'Ramen, udon or soba',note:'Comfort, by the bowlful.',icon:'ramen',color:'gold'},
  {id:'fish',name:'Prepared fish',description:'Gravlax or chef special',note:'Something worth slowing down for.',icon:'fish',color:'peach'},
  {id:'platter',name:'Platter',description:'Family or event order',note:'Good things are better shared.',icon:'platter',color:'lilac'},
  {id:'chef',name:'Chef’s choice',description:'Try something new',note:'Leave a little room for surprise.',icon:'chef',color:'blue'},
];
export const PRODUCTS = [
  {id:'salmon-maki',category:'maki',name:'Salmon avocado maki',detail:'Salmon, avocado, sesame. An everyday favourite.',price:1250,tag:'A GOOD PLACE TO START'},
  {id:'garden-maki',category:'maki',name:'Garden maki',detail:'Avocado, cucumber and pickled daikon.',price:1050,tag:'PLANT BASED'},
  {id:'onigiri',category:'rice',name:'Salmon onigiri',detail:'Seasoned rice, salmon and a crisp nori wrap.',price:650,tag:'SMALL BITE, BIG FLAVOUR'},
  {id:'poke',category:'rice',name:'Rainbow poke bowl',detail:'Salmon, rice, edamame, avocado and sesame.',price:1850,tag:'A LITTLE BIT OF EVERYTHING'},
  {id:'ramen',category:'noodles',name:'Miso ramen',detail:'Rich miso broth, noodles, mushrooms and egg.',price:1750,tag:'COMFORT IN A BOWL'},
  {id:'gravlax',category:'fish',name:'House-cured gravlax',detail:'Delicate salmon, fresh dill and citrus.',price:1600,tag:'SOMETHING DIFFERENT'},
  {id:'platter',category:'platter',name:'The sharing platter',detail:'An assortment of maki and nigiri for the table.',price:5800,tag:'MADE FOR YOUR PEOPLE'},
  {id:'chef-special',category:'chef',name:'Chef’s seasonal selection',detail:'A changing selection, chosen by the chef.',price:1450,tag:'TRUST YOUR CURIOSITY'},
];
export function emptyPassport(){return {version:1,name:'',stamps:{},directOrders:0,orders:[],redeemed:false};}
export function normalizePassport(value){
  const clean=emptyPassport();if(!value||typeof value!=='object')return clean;
  if(typeof value.name==='string')clean.name=value.name.slice(0,30);
  for(const cat of CATEGORIES){const date=value.stamps?.[cat.id];if(typeof date==='string'&&!Number.isNaN(Date.parse(date)))clean.stamps[cat.id]=date;}
  clean.orders=Array.isArray(value.orders)?value.orders.filter(o=>o&&typeof o.id==='string'&&typeof o.date==='string'&&Number.isInteger(o.total)&&o.total>=0).slice(0,50).map(o=>({id:o.id,date:o.date,total:o.total})):[];
  clean.directOrders=Number.isSafeInteger(value.directOrders)&&value.directOrders>0?value.directOrders:0;
  clean.redeemed=Object.keys(clean.stamps).length===6&&value.redeemed===true;
  return clean;
}
export function cartTotal(cart){return PRODUCTS.reduce((sum,p)=>sum+p.price*(Number.isInteger(cart[p.id])&&cart[p.id]>0?cart[p.id]:0),0);}
export function placeOrder(state,cart,date=new Date().toISOString()){
  const items=PRODUCTS.filter(p=>Number.isInteger(cart[p.id])&&cart[p.id]>0);
  if(!items.length)throw new Error('Add something delicious to your order first.');
  const next=normalizePassport(state),earned=[];
  for(const item of items)if(!next.stamps[item.category]){next.stamps[item.category]=date;earned.push(item.category);}
  next.directOrders++;
  next.orders.unshift({id:`UMP-${next.directOrders.toString().padStart(3,'0')}`,date,total:cartTotal(cart)});next.orders=next.orders.slice(0,50);
  return {state:next,earned};
}
export function redeemReward(state){
  const next=normalizePassport(state);
  if(Object.keys(next.stamps).length<6)throw new Error('Collect all six category stamps to unlock this reward.');
  if(next.redeemed)throw new Error('You’ve already redeemed this demo reward.');
  next.redeemed=true;return next;
}
