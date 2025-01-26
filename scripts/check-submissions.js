const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkSubmissions() {
  try {
    const submissions = await prisma.resume.findMany({
      include: {
        user: true
      }
    });
    
    console.log('Total submissions:', submissions.length);
    submissions.forEach(sub => {
      console.log('\nSubmission:', {
        id: sub.id,
        jobInterest: sub.jobInterest,
        description: sub.description,
        submittedAt: sub.submittedAt,
        user: {
          id: sub.user.id,
          email: sub.user.email
        }
      });
    });
  } catch (error) {
    console.error('Error fetching submissions:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkSubmissions(); 