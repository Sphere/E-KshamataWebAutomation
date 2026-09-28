import ExcelJS from 'exceljs';
import { mkdirSync } from 'node:fs';

// ── Tarento brand palette (80/15/5 navy/teal/gold) ──
const NAVY='FF16244C', TEAL='FF12A3A3', GOLD='FFC9A227',
      LIGHT='FFEEF2F7', LIGHTER='FFF7F9FC', WHITE='FFFFFFFF', GREY='FF5B6570', INK='FF1A1A1A';
const FONT='Open Sans';

// (Module, Section, Title, Preconditions, Steps, Expected, Priority, Type)
const TC=[
 ["Header & Navigation","App header","App header/logo visible on all private pages","Logged in as MP user","Open any private page (Home/My Courses/Competency/Account)","Header with app branding and search is shown on every private page","P2","UI"],
 ["Header & Navigation","Nav bar","All four primary tabs are present","Logged in","Observe the nav","Home, My Courses, Competency and Account tabs are visible","P1","UI"],
 ["Header & Navigation","Home tab","Home tab navigates to home","Logged in","Tap 'Home'","URL is /page/home and the Programs dashboard loads","P1","Navigation"],
 ["Header & Navigation","My Courses tab","My Courses tab navigates correctly","Logged in","Tap 'My Courses'","URL is /app/user/my_courses and enrolled courses load","P1","Navigation"],
 ["Header & Navigation","Competency tab","Competency tab navigates correctly","Logged in","Tap 'Competency'","URL is /app/user/competency and Competency Dashboard loads","P1","Navigation"],
 ["Header & Navigation","Account tab","Account tab navigates correctly","Logged in","Tap 'Account'","URL is /app/profile-view and the profile loads","P1","Navigation"],
 ["Header & Navigation","Active tab","Active tab is highlighted for current page","Logged in","Navigate across tabs","The tab matching the current page is visually highlighted","P3","UI"],
 ["Header & Navigation","Theme toggle","Dark/light theme toggle works","Logged in","Click the brightness (brightness_6) icon","The portal switches between light and dark theme","P2","Functional"],
 ["Header & Navigation","Theme toggle","Theme preference persists","Theme toggled","Change theme, then navigate and reload","The chosen theme is retained across pages and reload","P3","Functional"],
 ["Header & Navigation","Search bar","Search bar shows correct placeholder","Logged in","Observe the search box","Placeholder reads 'What do you want to learn today ?'","P3","UI"],
 ["Header & Navigation","Search bar","Search returns matching courses","Logged in","Type a valid course term and submit","Relevant course results are listed","P1","Functional"],
 ["Header & Navigation","Search bar","Search with no match shows empty state","Logged in","Search a nonsense string","A 'no result' style empty state is shown, no crash","P2","Negative"],
 ["Header & Navigation","Chat widget","'Chat with us' support opens","Logged in","Click 'Chat with us'","Support/chat widget opens","P3","Functional"],
 ["Footer","Quick Links","Footer quick links are present","On any private page","Scroll to footer","My Course, Policies, Privacy policy, Terms of Use, Help & Contact are shown","P2","UI"],
 ["Footer","Privacy policy","Privacy policy link works","Footer visible","Click 'Privacy policy'","Privacy policy content opens","P2","Navigation"],
 ["Footer","Terms of Use","Terms of Use link works","Footer visible","Click 'Terms of Use'","Terms of Use content opens","P2","Navigation"],
 ["Footer","Help & Contact","Help & Contact shows phone number","Footer visible","Click 'Help & Contact'","Contact details incl. tel:+918429036003 are shown","P3","Functional"],
 ["Footer","Mobile app","'Experience e-kshamata app on mobile' present","Footer visible","Observe footer","Mobile-app promo/link is present","P3","UI"],
 ["Footer","Copyright","Copyright/company text correct","Footer visible","Read the copyright line","Shows © 2026 Aastrika Foundation legal text","P3","UI"],
 ["Home / Programs","Programs section","Programs section renders on home","Logged in as MP","Open /page/home","A 'PROGRAMS' section with program cards is displayed","P1","UI"],
 ["Home / Programs","Program cards","All four MP program cards render","MP competency mapped","Observe the program cards","Antenatal, Intrapartum, Postpartum and HRP cards are shown","P1","Functional"],
 ["Home / Programs","Program card","Program card shows name, count and status","On home","Inspect a program card","Card shows program name, course count and In-Progress/Completed status","P1","UI"],
 ["Home / Programs","Antenatal card","Antenatal Care shows 9 courses In-Progress","MP mapping","Read the एंटीनेटल केयर card","Shows '9 Course' and 'In-Progress'","P2","Functional"],
 ["Home / Programs","Postpartum card","Postpartum Care shows 1 course Completed","MP mapping","Read the पोस्टपार्टम केयर card","Shows '1 Course' and 'Completed'","P2","Functional"],
 ["Home / Programs","Carousel","Program carousel scrolls horizontally","More cards than fit","Click chevron_left / chevron_right","The program carousel scrolls to reveal other cards","P2","UI"],
 ["Home / Programs","Program card","Clicking a program opens its detail","On home","Click a program card","The program detail page for that program opens","P1","Navigation"],
 ["Home / Programs","Course count","Program course count matches mapping","MP mapping known","Compare card count to mapped courses","Course counts match the MP competency framework","P2","Functional"],
 ["Program Detail","Banner","Program banner shows name + back","Program opened","Open a program","Banner shows program name and a back chevron","P2","UI"],
 ["Program Detail","Back","Back chevron returns to home","In program detail","Click back chevron","Returns to /page/home","P2","Navigation"],
 ["Program Detail","Continue Learning","Continue Learning shows in-progress courses","Has in-progress courses","Open a program","'CONTINUE LEARNING' lists courses with % complete","P1","Functional"],
 ["Program Detail","View All","Continue Learning 'View All' works","Continue section shown","Click 'View All'","Full list of continue-learning courses opens","P2","Navigation"],
 ["Program Detail","Completed","Completed section shows 100% courses","Has completed courses","Open a program with completions","'COMPLETED' lists courses at 100%","P2","Functional"],
 ["Program Detail","Learning Plan","Your Learning Plan shows plan/completion msg","Program opened","View 'YOUR LEARNING PLAN'","Recommended courses or a completion message is shown","P2","Functional"],
 ["Program Detail","Course card","Course card shows progress and action","Program opened","Inspect a course card","Card shows progress % and a resume/chevron action","P2","UI"],
 ["Program Detail","Open course","Clicking a course opens its TOC","Program opened","Click a course card","The course TOC/overview page opens","P1","Navigation"],
 ["My Courses","List","Enrolled courses are listed","Has enrollments","Open My Courses","Enrolled courses are listed as cards","P1","Functional"],
 ["My Courses","Count","Total enrolled count is shown","Has >10 courses","Observe 'Show More (10 of 32)'","Total enrolled count (e.g. 32) is displayed","P2","UI"],
 ["My Courses","Pagination","Show More loads additional courses","More than one page","Click 'Show More'","The next batch of courses is appended","P2","Functional"],
 ["My Courses","Course card","Card shows name, Resume and % complete","Has enrollments","Inspect a course card","Card shows course name, Resume CTA and progress %","P1","UI"],
 ["My Courses","Resume","Resume opens course at last position","Course partially done","Click 'Resume'","Course opens/continues at the last viewed position","P1","Functional"],
 ["My Courses","Progress","Progress % is accurate","Known progress","Compare shown % to actual","Progress values (0%, 10%, 71%…) are accurate","P2","Functional"],
 ["My Courses","Localization","Hindi & English titles render correctly","Mixed content","Scroll the list","Both Hindi and English course titles render without corruption","P2","Localization"],
 ["My Courses","Open course","Clicking a course opens its TOC","Has enrollments","Click a course card","The course overview/TOC opens","P1","Navigation"],
 ["My Courses","Completed","Completed course reflects 100%/certificate","Has a completed course","Find a completed course","Shows 100% and certificate availability","P2","Functional"],
 ["Competency","Heading","Competency Dashboard heading shown","Logged in","Open Competency","'Competency Dashboard' heading is displayed","P1","UI"],
 ["Competency","Job Description","Job Description section present","On competency page","Observe sections","'Job Description' section is present","P2","UI"],
 ["Competency","Passbook","Passbook section present","On competency page","Observe sections","'Passbook' section is present","P2","UI"],
 ["Competency","Required","Required section present","On competency page","Observe sections","'Required' section is present","P2","UI"],
 ["Competency","Self Assessments","Self Assessments empty state shown","No assessments","View 'Self Assessments'","Shows 'No result found' when there are none","P2","Negative"],
 ["Competency","Back","Back chevron returns to previous page","On competency page","Click back chevron","Returns to the previous page","P3","Navigation"],
 ["Account / Profile","Identity","Account shows name and position","Logged in as MP","Open Account","Shows account name and 'Position : ANM'","P1","Functional"],
 ["Account / Profile","Personal Details","Personal Details section renders","On profile","Open 'Personal Details'","User personal info is shown","P1","Functional"],
 ["Account / Profile","Organization Details","Org Details show position & department","MP org user","Open 'Organization Details'","Shows Position and Department Name for MP org","P1","Functional"],
 ["Account / Profile","Academic Details","Academic Details section present","On profile","Open 'Academic Details'","Academic details section renders","P2","UI"],
 ["Account / Profile","Language Preference","Language Preference is present/editable","On profile","Open 'Language Preference'","Language preference can be viewed/changed","P2","Functional"],
 ["Account / Profile","My Certificates","My Certificates lists earned certs","Has certificates","Open 'My Certificates'","Earned certificates are listed/downloadable","P2","Functional"],
 ["Account / Profile","Logout","Logout ends the session","Logged in","Click 'Logout'","Session ends and user returns to public/login","P1","Functional"],
 ["Account / Profile","Org scoping","Profile reflects MP org","MP user","Review org details","Org/designation reflect Madhya Pradesh - NHM","P2","Functional"],
 ["Course TOC","Header","TOC shows title, duration and provider","Course opened","Open a course TOC","Shows title, duration and 'By: Madhya Pradesh - National Health Mission'","P1","UI"],
 ["Course TOC","Rating","Course rating is displayed","Course has ratings","View TOC header","Rating value and count (e.g. 4.7 (44)) shown","P3","UI"],
 ["Course TOC","Tabs","Overview/Modules/Discussion tabs present","Course opened","Observe tabs","Overview, Modules and Discussion tabs are shown","P1","UI"],
 ["Course TOC","Overview","Overview shows description and license","On Overview tab","Read overview","Description and CC-BY license terms are shown","P2","UI"],
 ["Course TOC","Modules","Modules tab lists content","Course has modules","Open 'Modules' tab","Course modules/content list is shown","P1","Functional"],
 ["Course TOC","Discussion","Discussion tab loads","Course opened","Open 'Discussion' tab","Discussion area loads","P2","Functional"],
 ["Course TOC","Resume","Resume/Start launches the player","Course opened","Click 'Resume'","The content player launches at the correct position","P1","Functional"],
 ["Course TOC","Share","Share opens share options","Course opened","Click 'Share'","Share options are presented","P3","Functional"],
 ["Course TOC","Back","Back returns to source list","Opened from a list","Click back chevron","Returns to the originating list (My Courses/program)","P2","Navigation"],
 ["Session","Auth","Authenticated MP session loads private pages","Valid MP session","Open private routes","Pages load without redirect to /public","P1","Functional"],
 ["Session","Deep link","Direct private URL loads when authed","Valid session","Open /app/user/my_courses directly","The page loads directly for the authed user","P2","Functional"],
 ["Session","Expiry","Expired session redirects to public (prod)","Session expired","Open a private route on prod","User is redirected to /public/home / login","P2","Negative"],
];

const PRIO_FILL={P1:'FFFCE4E4',P2:'FFFFF6E0',P3:'FFE9F5EE'};
const PRIO_FONT={P1:'FFB00020',P2:'FF8A6D00',P3:'FF1E7A46'};
const solid=(argb)=>({type:'pattern',pattern:'solid',fgColor:{argb}});
const thin={style:'thin',color:{argb:'FFD2DAE5'}};
const box={top:thin,left:thin,right:thin,bottom:thin};

const wb=new ExcelJS.Workbook();
wb.creator='Ekshamata QA';

// ══ Cover ══
const cov=wb.addWorksheet('Cover',{views:[{showGridLines:false}]});
cov.columns=Array(9).fill({width:14});
cov.mergeCells('B2:H3');
const t=cov.getCell('B2'); t.value='Ekshamata Web Portal — Test Cases';
t.font={name:FONT,size:20,bold:true,color:{argb:WHITE}}; t.alignment={vertical:'middle',horizontal:'left',indent:1};
for(let r=2;r<=3;r++) for(let c=2;c<=8;c++) cov.getCell(r,c).fill=solid(NAVY);
cov.mergeCells('B4:H4');
const s=cov.getCell('B4'); s.value='MP Org (Madhya Pradesh – National Health Mission)   •   Private / authenticated pages';
s.font={name:FONT,size:11,bold:true,color:{argb:WHITE}}; s.alignment={vertical:'middle',horizontal:'left',indent:1};
for(let c=2;c<=8;c++) cov.getCell(4,c).fill=solid(TEAL);
const meta=[
 ["Application","Ekshamata web portal (Sunbird-based)"],
 ["Environment","Localhost (http://localhost:3000) — logged in as MP user Mpid003"],
 ["Org / User","Madhya Pradesh – National Health Mission   •   Position: ANM"],
 ["Scope","Private pages: Home/Programs, My Courses, Competency, Account, Course TOC, global header & footer"],
 ["Total test cases",String(TC.length)],
 ["Prepared","2026-07-15"],
];
let rr=6;
for(const [k,v] of meta){
  cov.mergeCells(`C${rr}:H${rr}`);
  const kc=cov.getCell(`B${rr}`); kc.value=k; kc.font={name:FONT,size:10,bold:true,color:{argb:NAVY}}; kc.alignment={vertical:'middle'};
  const vc=cov.getCell(`C${rr}`); vc.value=v; vc.font={name:FONT,size:10,color:{argb:INK}}; vc.alignment={vertical:'middle',wrapText:true};
  rr++;
}
cov.mergeCells(`B${rr+1}:H${rr+1}`);
const leg=cov.getCell(`B${rr+1}`);
leg.value='Priority:  P1 = critical/smoke  •  P2 = important  •  P3 = minor/cosmetic        Type:  Functional · UI · Navigation · Negative · Localization';
leg.font={name:FONT,size:9,italic:true,color:{argb:GREY}};

// ══ Test Cases ══
const ws=wb.addWorksheet('Test Cases',{views:[{showGridLines:false,state:'frozen',ySplit:1}]});
const headers=["TC ID","Module","Card / Section","Test Case","Preconditions","Test Steps","Expected Result","Priority","Type"];
const widths=[9,20,18,34,24,34,42,9,13];
ws.columns=widths.map(w=>({width:w}));
const hr=ws.getRow(1); hr.height=26;
headers.forEach((h,i)=>{const c=ws.getCell(1,i+1); c.value=h; c.font={name:FONT,size:10,bold:true,color:{argb:WHITE}};
  c.fill=solid(NAVY); c.alignment={horizontal:'center',vertical:'middle',wrapText:true}; c.border=box;});
TC.forEach((row,idx)=>{
  const r=idx+2; const tcid=`MP-${String(idx+1).padStart(3,'0')}`;
  const vals=[tcid,...row.slice(0,6),row[6],row[7]];
  const band=idx%2?LIGHTER:WHITE;
  vals.forEach((v,ci)=>{const c=ws.getCell(r,ci+1); c.value=v; c.border=box;
    c.alignment={horizontal:([0,7,8].includes(ci))?'center':'left',vertical:'middle',wrapText:true};
    c.font={name:FONT,size:9,bold:ci===0,color:{argb:ci===0?NAVY:INK}}; c.fill=solid(band);});
  const pc=ws.getCell(r,8); pc.fill=solid(PRIO_FILL[row[6]]); pc.font={name:FONT,size:9,bold:true,color:{argb:PRIO_FONT[row[6]]}};
});
ws.autoFilter={from:{row:1,column:1},to:{row:1,column:9}};

// ══ Summary (formulas) ══
const sm=wb.addWorksheet('Summary',{views:[{showGridLines:false}]});
sm.getColumn(1).width=3; sm.getColumn(2).width=24; sm.getColumn(3).width=12; sm.getColumn(4).width=12;
sm.mergeCells('B2:D2');
const sh=sm.getCell('B2'); sh.value='Coverage Summary'; sh.font={name:FONT,size:14,bold:true,color:{argb:WHITE}};
sh.alignment={vertical:'middle',horizontal:'left',indent:1};
for(let c=2;c<=4;c++) sm.getCell(2,c).fill=solid(NAVY);
const n=TC.length+1;
const modules=[...new Set(TC.map(t=>t[0]))];
sm.getCell('B4').value='By Module'; sm.getCell('B4').font={name:FONT,size:11,bold:true,color:{argb:TEAL}};
['Module','Count'].forEach((h,i)=>{const c=sm.getCell(5,2+i); c.value=h; c.font={name:FONT,size:10,bold:true,color:{argb:WHITE}};
  c.fill=solid(NAVY); c.alignment={horizontal:i?'center':'left'}; c.border=box;});
let r=6;
for(const m of modules){
  sm.getCell(r,2).value=m; sm.getCell(r,2).font={name:FONT,size:10,color:{argb:INK}}; sm.getCell(r,2).border=box;
  const cnt=TC.filter(t=>t[0]===m).length;
  const fc=sm.getCell(r,3); fc.value={formula:`COUNTIF('Test Cases'!$B$2:$B$${n},$B${r})`,result:cnt};
  fc.font={name:FONT,size:10,color:{argb:INK}}; fc.alignment={horizontal:'center'}; fc.border=box;
  r++;
}
sm.getCell(r,2).value='Total'; sm.getCell(r,2).font={name:FONT,size:10,bold:true,color:{argb:NAVY}}; sm.getCell(r,2).fill=solid(LIGHT); sm.getCell(r,2).border=box;
const tc=sm.getCell(r,3); tc.value={formula:`SUM(C6:C${r-1})`,result:TC.length}; tc.font={name:FONT,size:10,bold:true,color:{argb:NAVY}}; tc.alignment={horizontal:'center'}; tc.fill=solid(LIGHT); tc.border=box;
let pr=r+2;
sm.getCell(pr,2).value='By Priority'; sm.getCell(pr,2).font={name:FONT,size:11,bold:true,color:{argb:TEAL}}; pr++;
['Priority','Count'].forEach((h,i)=>{const c=sm.getCell(pr,2+i); c.value=h; c.font={name:FONT,size:10,bold:true,color:{argb:WHITE}};
  c.fill=solid(NAVY); c.alignment={horizontal:i?'center':'left'}; c.border=box;}); pr++;
for(const p of ['P1','P2','P3']){
  sm.getCell(pr,2).value=p; sm.getCell(pr,2).font={name:FONT,size:10,color:{argb:INK}}; sm.getCell(pr,2).border=box;
  const cnt=TC.filter(t=>t[6]===p).length;
  const fc=sm.getCell(pr,3); fc.value={formula:`COUNTIF('Test Cases'!$H$2:$H$${n},$B${pr})`,result:cnt};
  fc.font={name:FONT,size:10,color:{argb:INK}}; fc.alignment={horizontal:'center'}; fc.border=box; pr++;
}

mkdirSync('D:/Automation/EkshamataWebAutomation/test-cases',{recursive:true});
const out='D:/Automation/EkshamataWebAutomation/test-cases/Ekshamata_MP_PrivatePage_TestCases.xlsx';
await wb.xlsx.writeFile(out);
console.log('saved:',out,'| test cases:',TC.length,'| modules:',modules.length);
