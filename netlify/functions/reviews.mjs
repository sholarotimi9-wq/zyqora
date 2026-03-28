import { getStore } from '@netlify/blobs';
function j(d,s=200){ return new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json'}}); }
export default async (req) => {
  const store = getStore({name:'zyqora-reviews',consistency:'strong'});
  if(req.method==='GET'){
    try{
      const {blobs}=await store.list();
      const all=await Promise.all(blobs.map(b=>store.get(b.key,{type:'json'}).catch(()=>null)));
      const reviews=all.filter(r=>r&&r.approved!==false).sort((a,b)=>new Date(b.date)-new Date(a.date));
      const avg=reviews.length?(reviews.reduce((s,r)=>s+r.rating,0)/reviews.length).toFixed(1):'0.0';
      return j({reviews,total:reviews.length,avgRating:avg});
    }catch{ return j({reviews:[],total:0,avgRating:'0.0'}); }
  }
  if(req.method==='POST'){
    let body; try{ body=await req.json(); }catch{ return j({error:'Bad JSON'},400); }
    const {name,rating,text,template,outcome,email}=body;
    if(!name||!text||!rating) return j({error:'Name, text and rating required'},400);
    const id='rv-'+Date.now()+'-'+Math.random().toString(36).slice(2,6);
    const review={id,name:name.trim(),email:(email||'').trim(),rating:Math.min(5,Math.max(1,Number(rating))),text:text.trim(),template:template||'Traditional',outcome:outcome||'Still applying',date:new Date().toISOString(),approved:true};
    await store.setJSON(id,review);
    return j({success:true,review});
  }
  return j({error:'Method not allowed'},405);
};
export const config = { path: '/api/reviews' };
