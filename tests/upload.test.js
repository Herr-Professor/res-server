const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const API_URL = 'https://res-server-12bn.onrender.com';
const TEST_PDF_PATH = path.join(__dirname, 'test.pdf');

// Create a proper test PDF
function createTestPDF() {
  const pdfContent = `%PDF-1.4
1 0 obj
<< /Type /Catalog
   /Pages 2 0 R
>>
endobj

2 0 obj
<< /Type /Pages
   /Kids [3 0 R]
   /Count 1
>>
endobj

3 0 obj
<< /Type /Page
   /Parent 2 0 R
   /Resources << /Font << /F1 4 0 R >> >>
   /MediaBox [0 0 612 792]
   /Contents 5 0 R
>>
endobj

4 0 obj
<< /Type /Font
   /Subtype /Type1
   /BaseFont /Helvetica
>>
endobj

5 0 obj
<< /Length 44 >>
stream
BT
/F1 24 Tf
72 720 Td
(Test Resume) Tj
ET
endstream
endobj

xref
0 6
0000000000 65535 f
0000000010 00000 n
0000000063 00000 n
0000000125 00000 n
0000000247 00000 n
0000000325 00000 n

trailer
<< /Size 6
   /Root 1 0 R
>>
startxref
421
%%EOF`;

  fs.writeFileSync(TEST_PDF_PATH, pdfContent);
  console.log('Created test PDF at:', TEST_PDF_PATH);
}

// Create test PDF if it doesn't exist
if (!fs.existsSync(TEST_PDF_PATH)) {
  createTestPDF();
}

async function loginUser() {
  try {
    const response = await axios.post(`${API_URL}/api/auth/login`, {
      // Replace with your actual test credentials
      email: process.env.TEST_EMAIL || 'user@example.com',
      password: process.env.TEST_PASSWORD || 'password123'
    });
    return response.data.token;
  } catch (error) {
    console.error('Login error:', error.response?.data || error.message);
    throw error;
  }
}

async function testUpload() {
  try {
    // Step 1: Login and get token
    console.log('Step 1: Logging in...');
    const token = await loginUser();
    console.log('Login successful');

    // Step 2: Create form data
    console.log('Step 2: Creating form data...');
    const formData = new FormData();
    formData.append('resume', fs.createReadStream(TEST_PDF_PATH), {
      filename: 'test-resume.pdf',
      contentType: 'application/pdf'
    });
    formData.append('userId', '1');
    formData.append('plan', 'basic');
    formData.append('jobInterest', 'Software Developer');
    formData.append('description', 'Test upload');

    // Log form data contents
    console.log('Form data contents:', {
      resume: 'PDF file stream',
      userId: '1',
      plan: 'basic',
      jobInterest: 'Software Developer',
      description: 'Test upload'
    });

    // Step 3: Upload resume
    console.log('Step 3: Uploading resume...');
    const uploadResponse = await axios.post(
      `${API_URL}/api/resumes`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${token}`
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    );

    console.log('Upload successful:', uploadResponse.data);

    // Step 4: Create payment intent
    console.log('Step 4: Creating payment intent...');
    const paymentResponse = await axios.post(
      `${API_URL}/api/payment/create-payment-intent`,
      {
        plan: 'basic',
        resumeId: uploadResponse.data.resumeId
      },
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    console.log('Payment intent created:', paymentResponse.data);
    return true;
  } catch (error) {
    console.error('Test failed:');
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
      console.error('Response headers:', error.response.headers);
    } else if (error.request) {
      console.error('No response received:', error.request);
    } else {
      console.error('Error:', error.message);
    }
    return false;
  }
}

// Run the test
console.log('Starting upload test...');
testUpload()
  .then(success => {
    console.log('Test completed:', success ? 'PASSED' : 'FAILED');
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Test error:', error);
    process.exit(1);
  }); 