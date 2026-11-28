import('./lib/core.js').then(m => {
  const p = m.ALL_PATCHES;
  console.log('=== PATCHES INTEGRITY CHECK ===\n');
  
  // 1. 检查每个补丁的必要字段
  const errors = [];
  p.forEach((patch, idx) => {
    if (!patch.id || patch.id < 0) errors.push(`[${idx}] missing/invalid id`);
    if (!patch.name) errors.push(`[${idx}] missing name`);
    if (!patch.file && !patch.files) errors.push(`[${idx}] missing file/files`);
    if (!patch.replacements || !Array.isArray(patch.replacements)) errors.push(`[${idx}] missing/invalid replacements`);
    
    // 检查每个 replacement
    patch.replacements?.forEach((r, ridx) => {
      if (!r.pattern) errors.push(`[id:${patch.id}] replacement[${ridx}] missing pattern`);
      if (r.replace === undefined) errors.push(`[id:${patch.id}] replacement[${ridx}] missing replace`);
    });
  });
  
  if (errors.length > 0) {
    console.log('❌ ERRORS:');
    errors.forEach(e => console.log('  ' + e));
    process.exit(1);
  } else {
    console.log('✅ All patches have required fields');
  }
  
  // 2. 检查 ID 重复
  const ids = p.map(x => x.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) {
    console.log('❌ Duplicate IDs:', [...new Set(duplicates)]);
    process.exit(1);
  } else {
    console.log('✅ No duplicate IDs');
  }
  
  // 3. 检查 markers 是否与 skipIfMarked 配对
  const noMarkers = p.filter(x => !x.markers || x.markers.length === 0);
  const withSkip = noMarkers.filter(x => x.skipIfMarked);
  if (withSkip.length > 0) {
    console.log('⚠️  skipIfMarked but no markers:', withSkip.map(x => x.id));
  } else {
    console.log('✅ All skipIfMarked patches have markers');
  }
  
  // 4. 检查关键补丁 55/100/101/102
  const critical = [55, 100, 101, 102];
  critical.forEach(id => {
    const patch = p.find(x => x.id === id);
    if (!patch) {
      console.log(`❌ Critical patch ${id} not found`);
      process.exit(1);
    }
    console.log(`✅ Patch ${id}: ${patch.name} (${patch.file || patch.files})`);
  });
  
  console.log('\n📊 Summary:');
  console.log('  Total patches:', p.length);
  console.log('  Required (optional:false):', p.filter(x => !x.optional).length);
  console.log('  Optional (optional:true):', p.filter(x => x.optional).length);
  
  console.log('\n✅ All checks passed. Plugin can proceed.');
}).catch(e => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
