// SMART on FHIR OAuth2 callback.
// authorization code → access token 교환 후 FHIR 서버에서 환자 데이터 조회.
import FHIR from 'fhirclient';

const $ = (id) => document.getElementById(id);
const setStatus = (msg, cls = 'loading') => {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${cls}`;
};

FHIR.oauth2.ready().then(async (client) => {
  setStatus('✓ OAuth2 토큰 수신 완료. FHIR 서버에서 환자 정보 조회 중...', 'loading');

  try {
    // 1. EHR launch context에서 선택된 환자 조회
    const patient = await client.patient.read();
    $('patient-section').style.display = 'block';

    const name = patient.name?.[0];
    const display = name ? `${name.family} ${name.given?.join(' ') || ''}` : '(이름 없음)';
    const age = patient.birthDate
      ? Math.floor((Date.now() - new Date(patient.birthDate)) / (365.25 * 24 * 60 * 60 * 1000))
      : '?';
    const gender = { male: 'M', female: 'F', other: 'O' }[patient.gender] || '?';

    $('patient-summary').innerHTML = `
      <div style="font-size: 18px; font-family: Georgia, serif; margin-bottom: 8px;">${display}</div>
      <div style="font-family: monospace; font-size: 13px; color: #64748B;">
        ${gender} · ${age}세 · MRN: ${patient.id} · DOB: ${patient.birthDate || 'N/A'}
      </div>
    `;
    $('patient-raw').textContent = JSON.stringify(patient, null, 2);

    // 2. 환자의 진단 이력 (Condition)
    setStatus('✓ Patient OK. Conditions 조회 중...', 'loading');
    const conditionsBundle = await client.request(`Condition?patient=${patient.id}&_count=20`);
    $('conditions-section').style.display = 'block';
    const conditions = conditionsBundle.entry?.map(e => e.resource) || [];
    $('conditions-list').innerHTML = conditions.length
      ? conditions.map(c => `
          <div style="padding: 8px; border-bottom: 1px solid #E2E8F0; font-size: 13px;">
            <strong>${c.code?.text || c.code?.coding?.[0]?.display || '(name unknown)'}</strong>
            <span style="color: #64748B; font-family: monospace; font-size: 11px; margin-left: 8px;">
              ${c.code?.coding?.[0]?.code || ''} · ${c.clinicalStatus?.coding?.[0]?.code || 'unknown'}
            </span>
          </div>`).join('')
      : '<div style="color: #64748B; font-size: 13px;">기록된 진단 없음</div>';

    // 3. 최근 검사결과 (Observation)
    setStatus('✓ Conditions OK. Observations 조회 중...', 'loading');
    const obsBundle = await client.request(`Observation?patient=${patient.id}&_count=10&_sort=-date`);
    $('observations-section').style.display = 'block';
    const observations = obsBundle.entry?.map(e => e.resource) || [];
    $('observations-list').innerHTML = observations.length
      ? observations.map(o => `
          <div style="padding: 8px; border-bottom: 1px solid #E2E8F0; font-size: 13px;">
            <strong>${o.code?.text || o.code?.coding?.[0]?.display || '(unknown)'}</strong>
            <span style="margin-left: 8px;">${o.valueQuantity?.value ?? ''} ${o.valueQuantity?.unit || ''}</span>
            <span style="color: #64748B; font-family: monospace; font-size: 11px; margin-left: 8px;">
              ${o.effectiveDateTime?.split('T')[0] || ''}
            </span>
          </div>`).join('')
      : '<div style="color: #64748B; font-size: 13px;">기록된 검사 없음</div>';

    setStatus(`✓ FHIR 연결 완료. 환자 ${display}, ${conditions.length} conditions, ${observations.length} observations.`, 'success');
    $('next-step').style.display = 'block';

    // sessionStorage에 토큰 보관 → 메인 React 앱이 사용
    // (Mock 모드 구현 후 W2에 React 앱이 이걸 읽도록 연결)
    sessionStorage.setItem('SMART_PATIENT_ID', patient.id);
    sessionStorage.setItem('SMART_AUTHORIZED', 'true');

  } catch (err) {
    console.error(err);
    setStatus(`✗ 오류: ${err.message}`, 'error');
  }
}).catch(err => {
  setStatus(`✗ OAuth2 실패: ${err.message}`, 'error');
  console.error(err);
});
