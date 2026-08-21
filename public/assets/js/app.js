// public/assets/js/app.js
async function loadMeta(){
  const r = await fetch('/api/meta');
  const j = await r.json();
  return j.meta;
}

function elt(tag, attrs={}, text=''){
  const e = document.createElement(tag);
  Object.assign(e, attrs);
  if(text) e.textContent = text;
  return e;
}

async function init(){
  const meta = await loadMeta();
  const tiles = document.getElementById('tiles');
  tiles.innerHTML = '';

  const toggles = meta.portalToggles || {};

  const entries = [
    { id:'admin', title:'Admin Panel', desc:'Manage subjects, students, pdfs', enabled:true },
    { id:'teacher', title:'Teacher Portal', desc:'Enter marks & generate report', enabled: toggles.teacherPortal !== false },
    { id:'exam', title:'Exam Portal', desc:'Students take tests/exams', enabled: toggles.examPortal !== false },
    { id:'report', title:'Report Sheet Portal', desc:'Parents download reports', enabled: toggles.reportPortal !== false }
  ];

  entries.forEach(t=>{
    const tile = elt('div',{className: 'tile' + (t.enabled===false? ' disabled':'')});
    tile.appendChild(elt('div',{}, t.title));
    tile.appendChild(elt('div', {className:'small'}, t.desc));
    tile.onclick = () => {
      if(t.id==='admin') window.location.href = '/public/admin.html';
      else if (t.id==='teacher'){
        if(!t.enabled){ alert('Disabled by Admin'); return; }
        window.location.href = '/public/teacher.html';
      } else if (t.id==='exam'){
        if(!t.enabled){ alert('Disabled by Admin'); return; }
        window.location.href = '/public/exam.html';
      } else if (t.id==='report'){
        if(!t.enabled){ alert('Disabled by Admin'); return; }
        window.location.href = '/public/report.html';
      }
    };
    tiles.appendChild(tile);
  });
}

init();
