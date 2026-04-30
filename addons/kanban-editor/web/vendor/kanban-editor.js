(()=>{function J0($,K){if(!$)return $;let f=$.lanes.find((F)=>F.id===K.fromLaneId),j=$.lanes.find((F)=>F.id===K.toLaneId);if(!f||!j)return $;let J=f.cards.findIndex((F)=>F.id===K.cardId);if(J===-1)return $;let X=f.cards[J];if(!X)return $;let Y=Number.isFinite(K.toIndex)?Number(K.toIndex):j.cards.length;if(K.fromLaneId===K.toLaneId){let F=[...f.cards],[y]=F.splice(J,1);if(!y)return $;let q=Math.max(0,Math.min(Y,f.cards.length)),U=q>J?q-1:q;if(U===J)return $;return F.splice(U,0,y),{...$,lanes:$.lanes.map((z)=>z.id===K.fromLaneId?{...z,cards:F}:z)}}let Z=[...j.cards.filter((F)=>F.id!==K.cardId)],V=Math.max(0,Math.min(Y,Z.length));return Z.splice(V,0,X),{...$,lanes:$.lanes.map((F)=>{if(F.id===K.fromLaneId)return{...F,cards:F.cards.filter((y)=>y.id!==K.cardId)};if(F.id===K.toLaneId)return{...F,cards:Z};return F})}}function Q0($,K){if(!$||K.fromLaneId===K.toLaneId)return $;let f=$.lanes.findIndex((Y)=>Y.id===K.fromLaneId),j=$.lanes.findIndex((Y)=>Y.id===K.toLaneId);if(f===-1||j===-1)return $;let J=[...$.lanes],[X]=J.splice(f,1);if(!X)return $;return J.splice(j,0,X),{...$,lanes:J}}var n="piclaw-kanban-link:";function a($){let K=String($||"").replace(/\\+/g,"/");if(K.startsWith("/workspace/"))return K.slice(11);if(K==="/workspace")return"";if(K.startsWith("/"))return K.slice(1);return K}function e($){let K=String($||"").split("/"),f=[];for(let j of K){if(!j||j===".")continue;if(j===".."){if(f.length>0)f.pop();continue}f.push(j)}return f.join("/")}function U0($){let K=e(a($));if(!K)return"";let f=K.split("/");return f.pop(),f.join("/")}function B0($,K){return e([$,K].filter(Boolean).join("/"))}function R0($){return/\.[a-z0-9]+$/i.test($)}function A0($){return String($||"").replace(/\.kanban\.md$/i,"").replace(/\.md$/i,"")}function x0($){let K=a($).split("#")[0].trim(),f=K.split("/").pop()||K;return A0(f)||K||"board"}function Z0($){let K=String($||"").trim();if(!K)return null;let f=K.indexOf("|"),j=(f>=0?K.slice(0,f):K).trim(),J=(f>=0?K.slice(f+1):"").trim()||null;if(!j)return null;return{raw:K,target:j,label:J,displayLabel:J||x0(j)}}function N0($){return String($||"").replace(/\[\[([^\]]+)\]\]/g,(K,f)=>{let j=Z0(f);if(!j)return K;return`[${j.displayLabel}](piclaw-kanban-link:${encodeURIComponent(j.raw)})`})}function X0($,K=""){let j=Z0($)?.target||String($||"").trim();if(!j)return null;let J=j.split("#")[0].trim();if(!J)return null;let X=a(J),Y=R0(X)?X.replace(/\.kanban$/i,".kanban.md"):`${X}.kanban.md`,Z=U0(K);return(J.startsWith("/")?e(Y):B0(Z,Y))||null}var{h:M0,render:Y0}=preact,{useState:R,useEffect:w,useCallback:K0,useRef:d}=preactHooks,H=htm.bind(M0),_=null,s=null,j0="",b=null,r=0,B=null,D=null,F0=new Map,v=null,$0=null;function c($){if(typeof crypto<"u"&&typeof crypto.randomUUID==="function")return`${$}-${crypto.randomUUID()}`;return`${$}-${Date.now()}-${Math.random().toString(36).slice(2,11)}`}var S={grip:H`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>`,plus:H`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,plusCircle:H`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`,trash:H`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`,archive:H`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>`,restore:H`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`,moreVertical:H`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`,check:H`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,x:H`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`};function P0($){if(!$.startsWith(`---
`))return $;let K=$.indexOf(`
---
`,4);return K===-1?$:$.slice(K+5)}function T0($){let K=$.indexOf("%% kanban:settings");if(K===-1)return{settings:{},content:$};let f=$.indexOf("```",K);if(f===-1)return{settings:{},content:$};let j=$.indexOf("```",f+3);if(j===-1)return{settings:{},content:$};let J=$.slice(f+3,j).trim(),X={};try{X=JSON.parse(J)}catch{}let Y=$.indexOf("%%",j+3),Z=Y===-1?j+3:Y+2,V=`${$.slice(0,K).trimEnd()}
${$.slice(Z).trimStart()}`.trim();return{settings:X,content:V}}function t($){if($.startsWith("\\#")||$.startsWith("\\---"))return $;if($.startsWith("#")||$.startsWith("---"))return`\\${$}`;return $}function W0($){if($.startsWith("\\#")||$.startsWith("\\---"))return $.slice(1);return $}function _0($){return String($||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}function S0($){let K=String($||"").trim();if(!K)return"#";if(K.startsWith(n))return K;if(K.startsWith("#")||K.startsWith("/"))return K;try{let f=new URL(K,window.location.origin);if(["http:","https:","mailto:","tel:"].includes(f.protocol))return f.toString()}catch{}return"#"}function q0($){return $.replace(/\n/g,"<br>")}function I0($,K=""){let f=X0($,j0);if(!f||!_)return;_.dispatchEvent(new CustomEvent("pane:open-tab",{bubbles:!0,detail:{path:f,label:String(K||"").trim()||void 0}}))}function O0($){let K=String($||""),f=F0.get(K);if(f)return f;let j=_0(N0(K)),J=q0(j),X=globalThis?.marked;try{if(X?.parse)J=String(X.parse(j,{gfm:!0,breaks:!0,headerIds:!1,mangle:!1})||"")}catch{J=q0(j)}return J=J.replace(/<a\s+([^>]*?)href=(['"])(.*?)\2([^>]*)>/gi,(Y,Z,V,F,y)=>{let q=S0(F);if(q.startsWith(n)){let U=q.slice(n.length);return`<a ${Z}href="#" data-kanban-link="${U}" class="kanban-plugin__wiki-link"${y}>`}return`<a ${Z}href=${V}${q}${V}${y} target="_blank" rel="noopener noreferrer">`}),F0.set(K,J),J}function k0(){if(typeof document>"u")return null;if($0)return $0;let $=document.createElement("canvas");return $.width=1,$.height=1,$0=$,$}function y0(){if(typeof document>"u")return null;if(v?.isConnected)return v;let $=document.createElement("div");return $.className="kanban-plugin__drag-preview",document.body.appendChild($),v=$,$}function i($,K){let f=y0();if(!f)return;f.style.left=`${Math.round(Number($||0)+18)}px`,f.style.top=`${Math.round(Number(K||0)+18)}px`}function D0($,K){let f=y0();if(!f)return;f.innerHTML=`
    <div class="kanban-plugin__item kanban-plugin__item--drag-preview ${$.checked?"is-complete":""}">
      <div class="kanban-plugin__item-content-wrapper">
        <div class="kanban-plugin__item-title-wrapper">
          <div class="kanban-plugin__item-prefix-button-wrapper">
            <div class="kanban-plugin__item-checkbox ${$.checked?"is-checked":""}">${$.checked?"✓":""}</div>
          </div>
          <div class="kanban-plugin__item-title kanban-plugin__item-markdown">${O0($.title)}</div>
        </div>
      </div>
    </div>`,f.classList.add("is-visible"),i(Number(K?.clientX||0),Number(K?.clientY||0))}function o(){v?.classList.remove("is-visible")}function G0(){o(),v?.remove(),v=null}function H0($){let K={lanes:[],archive:[],settings:{}},f=P0($),j=T0(f);K.settings=j.settings,f=j.content;let J=f.split(/\n---\n/);if(K.lanes=V0(J[0]),J.length>1){let X=J.slice(1).join(`
---
`),Z=V0(X).find((V)=>V.title.toLowerCase()==="archive");if(Z)K.archive=Z.cards}return K}function V0($){let K=[],f=$.split(/(?=^## )/gm).filter((j)=>j.trim());for(let j of f){let J=j.split(`
`),X=J[0].match(/^## (.+)$/);if(!X)continue;let Y={id:c("lane"),title:X[1].trim(),cards:[]},Z=null,V="";for(let F=1;F<J.length;F++){let y=J[F],q=y.match(/^- \[(.)\] (.*)$/);if(q){if(Z)Z.title=V.trim(),Y.cards.push(Z);Z={id:c("card"),title:W0(q[2]),checkChar:q[1],checked:q[1]!==" "},V=W0(q[2])}else if(Z&&y.match(/^\s+\S/))V+=`
`+W0(y.replace(/^\s+/,""))}if(Z)Z.title=V.trim(),Y.cards.push(Z);K.push(Y)}return K}function f0($){let K=["---","","kanban-plugin: board","","---",""];for(let f of $.lanes){K.push(`## ${f.title}`,"");for(let j of f.cards){let J=`[${j.checked?j.checkChar!==" "?j.checkChar:"x":" "}]`,X=j.title.split(`
`);K.push(`- ${J} ${t(X[0])}`);for(let Y=1;Y<X.length;Y++)K.push(`  ${t(X[Y])}`)}K.push("")}if($.archive.length>0){K.push("---","","## Archive","");for(let f of $.archive){let j=f.title.split(`
`);K.push(`- [${f.checked?"x":" "}] ${t(j[0])}`);for(let J=1;J<j.length;J++)K.push(`  ${t(j[J])}`)}K.push("")}if(Object.keys($.settings).length>0)K.push("%% kanban:settings","```",JSON.stringify($.settings),"```","%%");return K.join(`
`)}function w0({checked:$,onChange:K}){return H`
    <div class="kanban-plugin__item-prefix-button-wrapper">
      <button class="kanban-plugin__item-checkbox ${$?"is-checked":""}"
        onClick=${(f)=>{f.stopPropagation(),K()}}>
        ${$?S.check:""}
      </button>
    </div>`}function L0({onArchive:$,isEditing:K,onCancelEdit:f}){return H`
    <div class="kanban-plugin__item-postfix-button-wrapper">
      ${K?H`
        <button class="kanban-plugin__item-postfix-button is-enabled"
          onClick=${(j)=>{j.stopPropagation(),f()}} title="Cancel">${S.x}</button>
      `:H`
        <button class="kanban-plugin__item-postfix-button"
          onClick=${(j)=>{j.stopPropagation(),$()}} title="Archive">${S.archive}</button>
      `}
    </div>`}function u0({card:$,laneId:K,cardIndex:f,onUpdate:j,onDelete:J,onArchive:X,onMoveCard:Y}){let[Z,V]=R(!1),[F,y]=R($.title),[q,U]=R(null),z=d(null);w(()=>{if(Z&&z.current)z.current.focus(),z.current.setSelectionRange(z.current.value.length,z.current.value.length),z.current.style.height="auto",z.current.style.height=z.current.scrollHeight+"px"},[Z]);let L=(W)=>{B={card:$,fromLaneId:K,fromIndex:f},W.dataTransfer.effectAllowed="move",W.dataTransfer.setData("text/plain",$.id);let Q=k0();if(Q&&W.dataTransfer?.setDragImage)W.dataTransfer.setDragImage(Q,0,0);D0($,{clientX:W.clientX,clientY:W.clientY}),setTimeout(()=>{W.target.classList.add("is-dragging")},0)},I=(W)=>{if(!B)return;i(W.clientX,W.clientY)},h=(W)=>{B=null,U(null),o(),W.target.classList.remove("is-dragging")},k=(W)=>{let Q=W.currentTarget.getBoundingClientRect();U(W.clientY>=Q.top+Q.height/2?"after":"before")},C=(W)=>{if(!B||Z)return;W.preventDefault(),W.stopPropagation(),W.dataTransfer.dropEffect="move",i(W.clientX,W.clientY),k(W)},P=(W)=>{let Q=W.currentTarget.getBoundingClientRect();if(W.clientX<Q.left||W.clientX>Q.right||W.clientY<Q.top||W.clientY>Q.bottom)U(null)},g=(W)=>{if(!B||Z)return;W.preventDefault(),W.stopPropagation();let Q=W.currentTarget.getBoundingClientRect(),O=W.clientY>=Q.top+Q.height/2;Y(B.card,B.fromLaneId,K,f+(O?1:0)),U(null),o(),B=null},u=()=>{j({...$,checked:!$.checked,checkChar:$.checked?" ":"x"})},T=(W)=>{let Q=W.target?.closest?.("a[data-kanban-link]");if(!Q)return;W.preventDefault(),W.stopPropagation();let O=Q.getAttribute("data-kanban-link")||"",N=O;try{N=O?decodeURIComponent(O):""}catch{}I0(N,Q.textContent||"")},E=()=>{if(F.trim())j({...$,title:F.trim()});V(!1)},M=(W)=>{if(W.key==="Enter"&&!W.shiftKey)W.preventDefault(),E();else if(W.key==="Escape")y($.title),V(!1)},m=(W)=>{y(W.target.value),W.target.style.height="auto",W.target.style.height=W.target.scrollHeight+"px"},G=()=>{y($.title),V(!1)};return H`
    <div class="kanban-plugin__item-wrapper ${q?`is-drop-${q}`:""}"
      onDragOver=${C}
      onDragLeave=${P}
      onDrop=${g}>
      <div class="kanban-plugin__item ${$.checked?"is-complete":""} ${Z?"is-editing":""}"
        draggable=${!Z}
        onKeyDown=${(W)=>{if((W.ctrlKey||W.metaKey)&&W.key.toLowerCase()==="e")W.preventDefault(),V(!0);if((W.ctrlKey||W.metaKey)&&W.key.toLowerCase()==="d")W.preventDefault(),J($);if((W.ctrlKey||W.metaKey)&&W.key.toLowerCase()==="a")W.preventDefault(),X($)}}
        onDragStart=${L} onDrag=${I} onDragEnd=${h}
        onDblClick=${()=>!Z&&V(!0)} tabindex="0">
        <div class="kanban-plugin__item-content-wrapper">
          <div class="kanban-plugin__item-title-wrapper">
            <${w0} checked=${$.checked} onChange=${u} />
            ${Z?H`
              <textarea ref=${z} class="kanban-plugin__item-edit-textarea"
                value=${F} onInput=${m}
                onBlur=${()=>{if(Z)E()}}
                onKeyDown=${M} />
            `:H`<div class="kanban-plugin__item-title kanban-plugin__item-markdown" onClick=${T} dangerouslySetInnerHTML=${{__html:O0($.title)}}></div>`}
            <${L0} isEditing=${Z}
              onArchive=${()=>X($)} onCancelEdit=${G} />
          </div>
        </div>
      </div>
    </div>`}function E0({onAdd:$,onCancel:K}){let[f,j]=R(""),J=d(null);w(()=>{J.current?.focus()},[]);let X=()=>{if(f.trim())$(f.trim()),j("")};return H`
    <div class="kanban-plugin__item-form">
      <div class="kanban-plugin__item-input-wrapper">
        <textarea ref=${J} placeholder="Card title..." value=${f}
          onInput=${(Z)=>j(Z.target.value)} onKeyDown=${(Z)=>{if(Z.key==="Enter"&&!Z.shiftKey)Z.preventDefault(),X();else if(Z.key==="Escape")K()}} rows="2" />
      </div>
      <div class="kanban-plugin__item-input-actions">
        <button class="kanban-plugin__item-action-add" onClick=${X}>Add card</button>
        <button class="kanban-plugin__item-action-cancel" onClick=${K}>Cancel</button>
      </div>
    </div>`}function m0({lane:$,laneIndex:K,onUpdate:f,onDelete:j,onAddCard:J,onUpdateCard:X,onDeleteCard:Y,onArchiveCard:Z,onMoveCard:V,onMoveLane:F}){let[y,q]=R(!1),[U,z]=R($.title),[L,I]=R(!1),[h,k]=R(!1),[C,P]=R(!1),[g,u]=R(!1),T=d(null);w(()=>{if(y&&T.current)T.current.focus(),T.current.select()},[y]);let E=(N)=>{if(N.preventDefault(),B)N.dataTransfer.dropEffect="move",i(N.clientX,N.clientY),k(!0);if(D)N.dataTransfer.dropEffect="move",P(!0)},M=(N)=>{let A=N.currentTarget.getBoundingClientRect();if(N.clientX<A.left||N.clientX>A.right||N.clientY<A.top||N.clientY>A.bottom)k(!1),P(!1)},m=(N)=>{if(N.preventDefault(),k(!1),P(!1),B)V(B.card,B.fromLaneId,$.id);if(D&&D.laneId!==$.id)F(D.laneId,$.id);o(),B=null,D=null},G=(N)=>{D={laneId:$.id,fromIndex:K},N.dataTransfer.effectAllowed="move",N.dataTransfer.setData("text/plain",$.id),u(!0)},W=()=>{D=null,P(!1),u(!1)},Q=()=>{if(U.trim())f({...$,title:U.trim()});q(!1)},O=(N)=>{J($.id,N),I(!1)};return H`
    <div class="kanban-plugin__lane-wrapper ${C?"is-lane-drop-target":""} ${g?"is-lane-dragging":""}"
      onDragOver=${E}
      onDragLeave=${M}
      onDrop=${m}>
      <div class="kanban-plugin__lane ${h?"is-dropping":""}">
        <div class="kanban-plugin__lane-header-wrapper">
          <div
            class="kanban-plugin__lane-grip"
            draggable=${!y&&!L}
            onDragStart=${G}
            onDragEnd=${W}
            title="Drag lane"
          >${S.grip}</div>
          <div class="kanban-plugin__lane-title">
            ${y?H`
              <input ref=${T} class="kanban-plugin__lane-title-input" value=${U}
                onInput=${(N)=>z(N.target.value)}
                onBlur=${()=>{if(y)Q()}}
                onKeyDown=${(N)=>{if(N.key==="Enter")Q();if(N.key==="Escape")z($.title),q(!1)}} />
            `:H`
              <div class="kanban-plugin__lane-title-text" onDblClick=${()=>q(!0)} title=${$.title}>${$.title}</div>
            `}
          </div>
          <div class="kanban-plugin__lane-settings-button-wrapper">
            <button class="kanban-plugin__lane-settings-button" onClick=${()=>I(!0)} title="Add card">${S.plusCircle}</button>
          </div>
        </div>
        <div class="kanban-plugin__lane-items">
          ${$.cards.map((N,A)=>H`
            <${u0} key=${N.id} card=${N} laneId=${$.id} cardIndex=${A}
              onUpdate=${(l)=>X($.id,l)}
              onDelete=${(l)=>Y($.id,l)}
              onArchive=${Z}
              onMoveCard=${V} />`)}
        </div>
        ${L?H`<${E0} onAdd=${O} onCancel=${()=>I(!1)} />`:null}
      </div>
    </div>`}function p0({onAdd:$,onCancel:K}){let[f,j]=R(""),J=d(null);w(()=>{J.current?.focus()},[]);let X=()=>{if(f.trim())$(f.trim())};return H`
    <div class="kanban-plugin__lane-form-wrapper">
      <input ref=${J} class="kanban-plugin__lane-input" placeholder="Enter lane title..." value=${f}
        onInput=${(Y)=>j(Y.target.value)}
        onKeyDown=${(Y)=>{if(Y.key==="Enter")Y.preventDefault(),X();else if(Y.key==="Escape")K()}} />
      <div class="kanban-plugin__lane-input-actions">
        <button class="kanban-plugin__lane-action-add" onClick=${X}>Add lane</button>
        <button class="kanban-plugin__lane-action-cancel" onClick=${K}>Cancel</button>
      </div>
    </div>`}function b0({cards:$,onRestore:K}){let[f,j]=R(!0);if($.length===0)return null;return H`
    <div class="kanban-plugin__archive">
      <div class="kanban-plugin__archive-header">
        <h3>${S.archive} Archive (${$.length})</h3>
        <button class="kanban-plugin__archive-toggle" onClick=${()=>j(!f)}>${f?"Hide":"Show"}</button>
      </div>
      ${f&&H`
        <div class="kanban-plugin__archive-cards">
          ${$.map((J)=>H`
            <div class="kanban-plugin__archive-card" key=${J.id}>
              <span class="kanban-plugin__archive-card-title">${J.title.split(`
`)[0]}</span>
              <button onClick=${()=>K(J)} title="Restore">${S.restore}</button>
            </div>`)}
        </div>`}
    </div>`}function p($){let K=String($?.title||"").split(`
`)[0].trim();if(!K)return"card";return K.length>36?`${K.slice(0,35)}…`:K}function x($){let K=String($?.title||"").trim();if(!K)return"lane";return K.length>28?`${K.slice(0,27)}…`:K}function v0({initialContent:$}){let[K,f]=R(()=>H0($??"")),[j,J]=R(!1),[X,Y]=R([]),[Z,V]=R([]),[F,y]=R(r);w(()=>{let G=setInterval(()=>{if(r!==F){if(y(r),b!==null)f(H0(b)),b=null}},100);return()=>clearInterval(G)},[F]);let q=K0((G,W="Updated board")=>{f(G),Y((Q)=>K?[...Q,{board:K,label:W}]:Q),V([]),s?.(f0(G))},[K]),U=K0(()=>{if(!K||X.length===0)return;let G=X[X.length-1];Y(X.slice(0,-1)),V((W)=>[...W,{board:K,label:G.label}]),f(G.board),s?.(f0(G.board))},[K,X]),z=K0(()=>{if(!K||Z.length===0)return;let G=Z[Z.length-1];V(Z.slice(0,-1)),Y((W)=>[...W,{board:K,label:G.label}]),f(G.board),s?.(f0(G.board))},[K,Z]);w(()=>{let G=_;if(!G)return;let W=(Q)=>{if(!(Q.ctrlKey||Q.metaKey))return;if(Q.key.toLowerCase()==="z")Q.preventDefault(),Q.shiftKey?z():U();else if(Q.key.toLowerCase()==="y")Q.preventDefault(),z()};return G.addEventListener("keydown",W),()=>G.removeEventListener("keydown",W)},[U,z]),w(()=>{if(typeof document>"u")return;let G=(Q)=>{if(!B)return;i(Q.clientX,Q.clientY)},W=()=>{o(),B=null};return document.addEventListener("dragover",G),document.addEventListener("drop",W),document.addEventListener("dragend",W),()=>{document.removeEventListener("dragover",G),document.removeEventListener("drop",W),document.removeEventListener("dragend",W),G0()}},[]);let L=(G)=>{if(!K)return;q({...K,lanes:[...K.lanes,{id:c("lane"),title:G,cards:[]}]},`Added lane “${x({id:"",title:G,cards:[]})}”`),J(!1)},I=(G)=>{if(!K)return;q({...K,lanes:K.lanes.map((W)=>W.id===G.id?G:W)},`Updated lane “${x(G)}”`)},h=(G)=>{if(!K)return;q({...K,lanes:K.lanes.filter((W)=>W.id!==G.id)},`Deleted lane “${x(G)}”`)},k=(G,W)=>{if(!K)return;let Q=K.lanes.find((A)=>A.id===G)||null,O=K.lanes.find((A)=>A.id===W)||null,N=Q0(K,{fromLaneId:G,toLaneId:W});if(N===K)return;q(N,`Moved lane “${x(Q)}” before “${x(O)}”`)},C=(G,W)=>{if(!K)return;let Q=K.lanes.find((N)=>N.id===G)||null,O={id:c("card"),title:W,checked:!1,checkChar:" "};q({...K,lanes:K.lanes.map((N)=>N.id===G?{...N,cards:[...N.cards,O]}:N)},`Added card to “${x(Q)}”`)},P=(G,W)=>{if(!K)return;let Q=K.lanes.find((O)=>O.id===G)||null;q({...K,lanes:K.lanes.map((O)=>O.id===G?{...O,cards:O.cards.map((N)=>N.id===W.id?W:N)}:O)},`Updated “${p(W)}” in “${x(Q)}”`)},g=(G,W)=>{if(!K)return;let Q=K.lanes.find((O)=>O.id===G)||null;q({...K,lanes:K.lanes.map((O)=>O.id===G?{...O,cards:O.cards.filter((N)=>N.id!==W.id)}:O)},`Deleted “${p(W)}” from “${x(Q)}”`)},u=(G)=>{if(!K)return;q({...K,lanes:K.lanes.map((W)=>({...W,cards:W.cards.filter((Q)=>Q.id!==G.id)})),archive:[...K.archive,{...G,checked:!0}]},`Archived “${p(G)}”`)},T=(G,W,Q,O)=>{if(!K)return;let N=K.lanes.find((z0)=>z0.id===Q)||null,A=J0(K,{cardId:G.id,fromLaneId:W,toLaneId:Q,toIndex:O});if(A===K)return;q(A,`${W===Q?"Reordered":"Moved"} “${p(G)}” in “${x(N)}”`)},E=(G)=>{if(!K)return;if(K.lanes.length===0){q({...K,lanes:[{id:c("lane"),title:"Restored",cards:[{...G,checked:!1}]}],archive:K.archive.filter((Q)=>Q.id!==G.id)},`Restored “${p(G)}”`);return}let W=K.lanes[0];q({...K,lanes:K.lanes.map((Q)=>Q.id===W.id?{...Q,cards:[...Q.cards,{...G,checked:!1}]}:Q),archive:K.archive.filter((Q)=>Q.id!==G.id)},`Restored “${p(G)}” to “${x(W)}”`)};if(!K)return H`<div class="loading">Loading...</div>`;let M=X.length>0?X[X.length-1]:null,m=Z.length>0?Z[Z.length-1]:null;return H`
    <div class="kanban-plugin" tabindex="-1">
      <div class="kanban-plugin__search-wrapper">
        <button onClick=${()=>J(!0)}>${S.plus} Add lane</button>
        <button class="secondary" onClick=${U} disabled=${X.length===0} title=${M?`Undo: ${M.label} (Ctrl+Z)`:"Undo (Ctrl+Z)"}>Undo</button>
        <button class="secondary" onClick=${z} disabled=${Z.length===0} title=${m?`Redo: ${m.label} (Ctrl+Y)`:"Redo (Ctrl+Y)"}>Redo</button>
        ${M&&H`<span class="kanban-plugin__history-note" title=${M.label}>Last change: ${M.label}</span>`}
      </div>
      <div class="kanban-plugin__board"><div>
        ${K.lanes.map((G,W)=>H`
          <${m0} key=${G.id} lane=${G} laneIndex=${W} onUpdate=${I} onDelete=${h}
            onAddCard=${C} onUpdateCard=${P} onDeleteCard=${g}
            onArchiveCard=${u} onMoveCard=${T} onMoveLane=${k} />`)}
        ${j&&H`<${p0} onAdd=${L} onCancel=${()=>J(!1)} />`}
      </div></div>
      <${b0} cards=${K.archive} onRestore=${E} />
    </div>`}window.__kanbanEditor={mount($,K){if(_=$,s=K.onEdit,j0=String(K.path||""),B=null,b=null,G0(),!K.isDark)$.classList.add("light");Y0(H`<${v0} initialContent=${K.content} />`,$)},update($){b=$,r++},setTheme($){_?.classList.toggle("light",!$)},destroy(){if(_)Y0(null,_);_=null,s=null,j0="",b=null,B=null,G0()}};})();
