// Script to query the database and display current state
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Starting database query script...');
  
  try {
    // Test database connection
    console.log('Testing database connection...');
    await prisma.$connect();
    console.log('Database connection successful!');
    
    console.log('Querying database...\n');

    // Get all users with their credits
    console.log('Fetching users...');
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        ppuAtsCredits: true,
        ppuOptimizationCredits: true,
        subscriptionStatus: true,
      },
    });
    console.log(`Found ${users.length} users`);
    console.log('=== USERS ===');
    console.log(JSON.stringify(users, null, 2));
    console.log('\n');

    // Get all resumes with their statuses
    console.log('Fetching resumes...');
    const resumes = await prisma.resume.findMany({
      select: {
        id: true,
        fileUrl: true,
        originalFileName: true,
        status: true,
        userId: true,
        submittedAt: true,
        completedAt: true,
      },
    });
    console.log(`Found ${resumes.length} resumes`);
    console.log('=== RESUMES ===');
    console.log(JSON.stringify(resumes, null, 2));
    console.log('\n');

    // Get all review orders with their statuses
    console.log('Fetching review orders...');
    const reviewOrders = await prisma.reviewOrder.findMany({
      select: {
        id: true,
        status: true,
        userId: true,
        resumeId: true,
        submittedDate: true,
        completedDate: true,
      },
    });
    console.log(`Found ${reviewOrders.length} review orders`);
    console.log('=== REVIEW ORDERS ===');
    console.log(JSON.stringify(reviewOrders, null, 2));
    console.log('\n');

    // If we have users, calculate stats for the first user
    if (users.length > 0) {
      const targetUserId = 31;
      const targetUser = users.find(user => user.id === targetUserId);

      if (targetUser) {
        console.log(`Calculating stats for user ID: ${targetUserId}`);
        
        const userResumes = await prisma.resume.findMany({
          where: { userId: targetUserId },
          select: { status: true },
        });
        
        const userReviewOrders = await prisma.reviewOrder.findMany({
          where: { userId: targetUserId },
          select: { status: true },
        });
        
        const userProfile = await prisma.user.findUnique({
          where: { id: targetUserId },
          select: {
            ppuAtsCredits: true,
            ppuOptimizationCredits: true,
          },
        });

        // Calculate stats similar to the /stats endpoint
        const stats = {
          resumesUploaded: userResumes.length,
          analysesCompleted: {
            basicAts: userResumes.filter(r => r.status === 'basic_ats_complete' || r.status === 'detailed_ats_complete').length,
            detailedAts: userResumes.filter(r => r.status === 'detailed_ats_complete').length,
            jobOpt: userResumes.filter(r => r.status === 'job_opt_complete').length,
            review: userResumes.filter(r => r.status === 'review_complete').length,
            total: userResumes.filter(r => 
              r.status === 'basic_ats_complete' || 
              r.status === 'detailed_ats_complete' || 
              r.status === 'job_opt_complete' ||
              r.status === 'review_complete'
            ).length
          },
          pendingReviews: userReviewOrders.filter(r => 
            r.status === 'requested' || 
            r.status === 'in_progress'
          ).length,
          completedReviews: userReviewOrders.filter(r => 
            r.status === 'completed'
          ).length,
          atsCredits: userProfile.ppuAtsCredits,
          optimizationCredits: userProfile.ppuOptimizationCredits
        };

        console.log(`=== CALCULATED STATS FOR USER ${targetUserId} ===`);
        console.log(JSON.stringify(stats, null, 2));
      } else {
        console.log('No users found in the database, skipping stats calculation.');
      }
    } else {
      console.log('No users found in the database, skipping stats calculation.');
    }
  } catch (error) {
    console.error('Error during database operations:');
    console.error(error);
  }
}

main()
  .catch((e) => {
    console.error('Unhandled error in main function:');
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    console.log('Disconnecting from database...');
    await prisma.$disconnect();
    console.log('Disconnected successfully.');
  }); 