document.addEventListener("DOMContentLoaded",()=>{

const calc=document.getElementById("cbt-calculator");
const display=document.getElementById("calc-display");

/* BUTTON INPUT */

document.querySelectorAll("#calc-buttons [data-val]").forEach(btn=>{
btn.onclick=()=>{
display.value+=btn.dataset.val;
};
});

/* CLEAR */

document.getElementById("calc-clear").onclick=()=>{
display.value="";
};

/* BACKSPACE */

document.getElementById("calc-back").onclick=()=>{
display.value=display.value.slice(0,-1);
};

/* EQUAL */

document.getElementById("calc-equal").onclick=()=>{
try{
display.value=eval(display.value);
}catch{
display.value="ERR";
}
};

/* CLOSE */

document.getElementById("calc-close").onclick=()=>{
calc.style.display="none";
};

/* MINIMIZE */

document.getElementById("calc-min").onclick=()=>{
const buttons=document.getElementById("calc-buttons");
buttons.style.display=buttons.style.display==="none"?"grid":"none";
};

/* DRAGGABLE */

let isDragging=false,offsetX,offsetY;

document.getElementById("calc-header").addEventListener("mousedown",(e)=>{
isDragging=true;
offsetX=e.clientX-calc.offsetLeft;
offsetY=e.clientY-calc.offsetTop;
});

document.addEventListener("mousemove",(e)=>{
if(!isDragging)return;
calc.style.left=e.clientX-offsetX+"px";
calc.style.top=e.clientY-offsetY+"px";
calc.style.bottom="auto";
calc.style.right="auto";
});

document.addEventListener("mouseup",()=>{
isDragging=false;
});

/* KEYBOARD SUPPORT */

document.addEventListener("keydown",(e)=>{

if(!calc || calc.style.display==="none") return;

if("0123456789+-*/.".includes(e.key)){
display.value+=e.key;
}

if(e.key==="Backspace"){
display.value=display.value.slice(0,-1);
}

if(e.key==="Enter"){
try{
display.value=eval(display.value);
}catch{
display.value="ERR";
}
}

});

});