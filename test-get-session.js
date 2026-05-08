// Test GET /session endpoint
console.log('=== Testing GET /session ===\n');

const token = localStorage.getItem('cognito_id_token');
console.log('Token available:', !!token);

if (!token) {
  console.error('No token found');
} else {
  // Test 1: GET /session with Authorization header
  console.log('\n1. Testing GET /session with Authorization header:');
  fetch('https://4aukdm2t58.execute-api.ca-central-1.amazonaws.com/session', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  })
  .then(r => {
    console.log('   Status:', r.status);
    console.log('   Headers:', {
      'content-type': r.headers.get('content-type'),
      'access-control-allow-origin': r.headers.get('access-control-allow-origin')
    });
    return r.json();
  })
  .then(d => {
    console.log('   Response:', JSON.stringify(d, null, 2));
  })
  .catch(e => {
    console.error('   Error:', e.message);
  });

  // Test 2: GET /session without Authorization header (should fail)
  console.log('\n2. Testing GET /session WITHOUT Authorization header (should fail):');
  setTimeout(() => {
    fetch('https://4aukdm2t58.execute-api.ca-central-1.amazonaws.com/session', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    })
    .then(r => {
      console.log('   Status:', r.status);
      return r.json();
    })
    .then(d => {
      console.log('   Response:', JSON.stringify(d, null, 2));
    })
    .catch(e => {
      console.error('   Error:', e.message);
    });
  }, 1000);
}
