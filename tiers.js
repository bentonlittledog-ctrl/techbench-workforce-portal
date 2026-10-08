// Repair tiers and the rules that suggest one from the parts on a repair (the district's repair fee schedule).
const TIERS = {
    1: { name: 'Basic Repair', fee: 25, items: ['Keyboard', 'Trackpad', 'Bezel', 'Battery', 'Charger / AC adapter', 'Protective case', 'Other small parts, as assessed by KPS'],
         note: 'Each additional Basic Repair item in the same incident may move the claim to the next tier.' },
    2: { name: 'Moderate Repair', fee: 100, items: ['Screen', 'Camera', 'Palmrest assembly', 'Hinges', 'Body damage (2+ areas)', 'Other standard parts, as assessed by KPS'],
         note: 'Each additional Standard Repair item in the same incident may move the claim to the next tier. Two or more Basic Repair items in the same incident may be billed at this tier.' },
    3: { name: 'Advanced Repair', fee: 200, items: ['Motherboard', 'Daughterboard', 'Other major parts, as assessed by KPS'],
         note: 'A combination of Basic and Standard Repair items in the same incident may be billed at this tier.' },
    4: { name: 'Device Replacement', fee: 400, items: ['Device lost', 'Device stolen (police report required)', 'Damage beyond repair', 'Device not returned at check-in'], note: '' }
};
const SPECIALS = ['Device lost', 'Device stolen (police report required)', 'Damage beyond repair', 'Device not returned at check-in'];
const label = n => TIERS[n] ? 'Tier ' + n + ' - ' + TIERS[n].name : '';
// "Tier 2", "tier 2 - standard repair", "2" ... -> 2 (or 0 when there is no tier number)
const num = text => { const m = /tier\s*([1-4])\b/i.exec(String(text || '')) || /^\s*([1-4])\s*$/.exec(String(text || '')); return m ? parseInt(m[1], 10) : 0; };

// Keep this in step with classifyTier_ in appsscript/Code.gs (the tests check that both give the same answers).
function classify(parts, special) {
    const major = /motherboard|daughter ?board|logic board|mainboard|system board/i;
    const std = /screen|lcd|display|digitizer|camera|webcam|palm ?rest|hinge|body damage|top cover|bottom cover|chassis|housing/i;
    const basic = /keyboard|track ?pad|touch ?pad|bezel|battery|charger|adapter|power cord|case/i;
    let nM = 0, nS = 0, nB = 0; const other = [];
    (parts || []).forEach(p => {
        p = String(p);
        if (major.test(p)) nM++;
        else if (std.test(p)) nS++;
        else { nB++; if (!basic.test(p)) other.push(p); }
    });
    let tier = null, why = '';
    if (special) { tier = 4; why = 'Lost, stolen, beyond repair or not returned'; }
    else if (nM) { tier = 3; why = 'It includes a major part'; }
    else if (nS) {
        if (nS >= 2) { tier = 3; why = 'Two or more standard repair items'; }
        else if (nB >= 1) { tier = 3; why = 'Standard and basic repair items together'; }
        else { tier = 2; why = 'A standard repair item'; }
    }
    else if (nB >= 2) { tier = 2; why = 'Two or more basic repair items'; }
    else if (nB === 1) { tier = 1; why = 'One basic repair item'; }
    return { tier, why, other };
}
const splitParts = text => String(text || '').split(',').map(s => s.trim()).filter(Boolean);

module.exports = { TIERS, SPECIALS, label, num, classify, splitParts };
