// A square, keyboard-operable crop; only the resized result is retained.
export async function cropPhoto(file){
  if(!file.size||file.size>12*1024*1024)throw new Error('请选择 12 MB 以内的 PNG、JPG 或 WebP 图片。');
  // Windows file associations can report an empty or incorrect File.type.
  const bytes=new Uint8Array(await file.slice(0,12).arrayBuffer());
  const starts=signature=>signature.every((value,index)=>bytes[index]===value);
  const type=starts([137,80,78,71,13,10,26,10])?'image/png':starts([255,216,255])?'image/jpeg':starts([82,73,70,70])&&[87,69,66,80].every((value,index)=>bytes[index+8]===value)?'image/webp':null;
  if(!type)throw new Error('请选择 PNG、JPG 或 WebP 图片；HEIC 照片请先导出为 JPG。');
  const url=URL.createObjectURL(file.slice(0,file.size,type)),image=new Image();image.src=url;
  try{await image.decode();}catch{URL.revokeObjectURL(url);throw new Error('这张照片无法打开，请换一张完整的 PNG、JPG 或 WebP 图片。');}
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');dialog.setAttribute('aria-label','裁切头像');dialog.innerHTML=`<h2>让脸部清楚地留在画面里</h2><p>拖动画面，或用下面的滑块调整。保存后只保留裁切照片。</p><canvas width="320" height="320" style="width:320px;height:320px;max-width:100%;touch-action:none;border-radius:20px;display:block;margin:16px auto"></canvas><label class="field">缩放<input aria-label="照片缩放" type="range" min="1" max="4" step=".01" value="1" data-crop="zoom"></label><label class="field">左右位置<input aria-label="照片左右位置" type="range" min="-1" max="1" step=".01" value="0" data-crop="x"></label><label class="field">上下位置<input aria-label="照片上下位置" type="range" min="-1" max="1" step=".01" value="0" data-crop="y"></label><div class="dialog-actions"><button type="button" class="button" data-cancel>取消</button><button type="button" class="button primary" data-save>使用这张头像</button></div>`;document.body.append(dialog);
    const canvas=dialog.querySelector('canvas'),ctx=canvas.getContext('2d'),controls=Object.fromEntries([...dialog.querySelectorAll('[data-crop]')].map(e=>[e.dataset.crop,e]));
    const draw=()=>{const scale=Math.max(320/image.width,320/image.height)*Number(controls.zoom.value),w=image.width*scale,h=image.height*scale;ctx.fillStyle='#fff';ctx.fillRect(0,0,320,320);ctx.drawImage(image,(320-w)/2+Number(controls.x.value)*(w-320)/2,(320-h)/2+Number(controls.y.value)*(h-320)/2,w,h);};
    Object.values(controls).forEach(e=>e.oninput=draw);let drag;
    canvas.onpointerdown=e=>{drag={x:e.clientX,y:e.clientY,px:Number(controls.x.value),py:Number(controls.y.value)};canvas.setPointerCapture(e.pointerId);};
    canvas.onpointermove=e=>{if(!drag)return;const scale=Math.max(320/image.width,320/image.height)*Number(controls.zoom.value);controls.x.value=String(Math.max(-1,Math.min(1,drag.px+(e.clientX-drag.x)/Math.max(1,(image.width*scale-320)/2))));controls.y.value=String(Math.max(-1,Math.min(1,drag.py+(e.clientY-drag.y)/Math.max(1,(image.height*scale-320)/2))));draw();};canvas.onpointerup=()=>{drag=null;};
    const finish=value=>{dialog.close();dialog.remove();URL.revokeObjectURL(url);resolve(value);};dialog.querySelector('[data-save]').onclick=()=>finish(canvas.toDataURL('image/jpeg',.88));dialog.querySelector('[data-cancel]').onclick=()=>finish(null);dialog.oncancel=e=>{e.preventDefault();finish(null);};dialog.showModal();draw();
  });
}
