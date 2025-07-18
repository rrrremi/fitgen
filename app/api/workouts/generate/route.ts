import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';
import { generateWorkout } from '@/lib/openai';
import { WorkoutGenerationRequest } from '@/types/workout';
import { findOrCreateExercise, linkExerciseToWorkout, calculateWorkoutSummary } from '@/lib/exercises/database';

// Rate limit: 100 generations per day per user
const RATE_LIMIT = 100;
const RATE_LIMIT_WINDOW_HOURS = 24;

// Valid input options
const ALLOWED_MUSCLES = ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'forearms', 'neck', 'core', 'glutes', 'quads', 'hamstrings', 'calves'];
const ALLOWED_FOCUS = ['cardio', 'hypertrophy', 'isolation', 'strength', 'speed', 'stability', 'activation', 'stretch', 'mobility', 'plyometric'];

export async function POST(request: NextRequest) {
  try {
    // Create Supabase client
    const supabase = createClient();
    
    // Check if user is authenticated
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    // Parse request body
    let body: WorkoutGenerationRequest;
    try {
      body = await request.json();
    } catch (e) {
      // If no body provided, use default values
      body = {
        muscle_focus: [],
        workout_focus: 'hypertrophy',
        exercise_count: 4,
        special_instructions: ''
      };
    }
    
    // Validate request body
    const validationError = validateRequest(body);
    if (validationError) {
      console.error('Request validation failed:', { 
        error: validationError, 
        body: JSON.stringify(body)
      });
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    // 2. Check Rate Limit
    const now = new Date()
    const dayStart = new Date(now)
    dayStart.setHours(now.getHours() - RATE_LIMIT_WINDOW_HOURS)

    const { count } = await supabase
      .from('workouts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .gte('created_at', dayStart.toISOString())

    if (count !== null && count >= RATE_LIMIT) {
      return NextResponse.json(
        { success: false, error: 'Daily limit reached. Try again tomorrow.' },
        { status: 429 }
      )
    }

    // Generate workout with user inputs
    console.log('Attempting to generate workout with OpenAI...');
    console.log('OpenAI API Key exists:', !!process.env.OPENAI_API_KEY);
    console.log('OpenAI API Key prefix:', process.env.OPENAI_API_KEY?.substring(0, 7) + '...');
    
    // Declare result variable outside the try block so it's accessible throughout the function
    let result;
    
    try {
      result = await generateWorkout(
        body.muscle_focus, 
        body.workout_focus, 
        body.exercise_count,
        body.special_instructions,
        false, // Not a retry
        true   // Use exercise database prompt for enhanced exercise data
      );
      
      if (!result.success) {
        console.error('Failed to generate workout:', result.error);
        return NextResponse.json({ error: `Failed to generate workout: ${result.error}` }, { status: 500 });
      }
    } catch (openaiError) {
      console.error('OpenAI API error:', openaiError);
      return NextResponse.json({ 
        error: 'OpenAI API error', 
        details: openaiError instanceof Error ? openaiError.message : 'Unknown error' 
      }, { status: 500 });
    }

    // 4. Store in Database - Begin transaction
    console.log('Starting database transaction for workout and exercises');
    
    try {
      // 4.1 First save the workout
      const { data: workout, error: insertError } = await supabase
        .from('workouts')
        .insert({
          user_id: user.id,
          total_duration_minutes: result.data!.total_duration_minutes,
          muscle_groups_targeted: result.data!.muscle_groups_targeted,
          joint_groups_affected: result.data!.joint_groups_affected,
          equipment_needed: result.data!.equipment_needed,
          workout_data: result.data!,
          raw_ai_response: result.rawResponse,
          ai_model: 'gpt-3.5-turbo',
          prompt_tokens: result.usage?.promptTokens,
          completion_tokens: result.usage?.completionTokens,
          generation_time_ms: result.generationTimeMs,
          parse_attempts: result.parseAttempts,
          // Save the customization fields
          muscle_focus: body.muscle_focus,
          workout_focus: body.workout_focus,
          exercise_count: body.exercise_count,
          special_instructions: body.special_instructions
        })
        .select('id')
        .single();
      
      if (insertError) {
        throw new Error(`Failed to insert workout: ${insertError.message}`);
      }
      
      if (!workout || !workout.id) {
        throw new Error('No workout ID returned from database insert');
      }
      
      console.log('Successfully inserted workout with ID:', workout.id);
      
      // 4.2 Try to process and save each exercise if the exercise database tables exist
      try {
        const exerciseRecords = [];
        
        // Check if the exercises table exists by making a simple query
        const { error: tableCheckError } = await supabase
          .from('exercises')
          .select('id')
          .limit(1);
        
        // If the table doesn't exist, skip the exercise database integration
        if (tableCheckError && tableCheckError.code === 'PGRST116') {
          console.log('Exercises table does not exist, skipping exercise database integration');
        } else {
          // Use standard for loop instead of for...of with entries() to avoid downlevelIteration issues
          for (let index = 0; index < result.data!.exercises.length; index++) {
            const exerciseData = result.data!.exercises[index];
            // Convert rest_time_seconds to rest_seconds for database consistency
            const rest_seconds = exerciseData.rest_time_seconds;
            
            // Create or find the exercise in the database
            const { exercise, created } = await findOrCreateExercise({
              name: exerciseData.name,
              primary_muscles: exerciseData.primary_muscles || [],
              secondary_muscles: exerciseData.secondary_muscles,
              equipment: exerciseData.equipment,
              movement_type: exerciseData.movement_type
            });
            
            console.log(`${created ? 'Created' : 'Found'} exercise: ${exercise.name} (${exercise.id})`);
            
            // Link the exercise to the workout
            const workoutExercise = await linkExerciseToWorkout(
              workout.id,
              exercise.id,
              {
                order_index: exerciseData.order_index || index + 1,
                sets: exerciseData.sets,
                reps: exerciseData.reps,
                rest_seconds: rest_seconds,
                rationale: exerciseData.rationale
              }
            );
            
            exerciseRecords.push({
              ...exercise,
              sets: exerciseData.sets,
              rest_seconds: rest_seconds
            });
          }
          
          // 4.3 Calculate and update workout summary fields
          const summary = calculateWorkoutSummary(exerciseRecords);
          
          // Check if the workouts table has the summary fields
          const { error: updateError } = await supabase
            .from('workouts')
            .update({
              total_sets: summary.total_sets,
              total_exercises: summary.total_exercises,
              estimated_duration_minutes: summary.estimated_duration_minutes,
              primary_muscles_targeted: summary.primary_muscles_targeted,
              equipment_needed_array: summary.equipment_needed
            })
            .eq('id', workout.id);
    
          if (updateError) {
            console.error('Failed to update workout summary:', updateError);
            // Continue anyway since the core data is saved
          }
        }
      } catch (exerciseDbError) {
        // Log the error but continue since we can still return the workout without exercise database integration
        console.error('Error during exercise database integration:', exerciseDbError);
        console.log('Continuing without exercise database integration');
      }
      
      // 5. Return Success
      console.log('Returning success response with workout ID:', workout.id);
      return NextResponse.json({
        success: true,
        workoutId: workout.id
      });
    } catch (dbError) {
      console.error('Database operation error:', dbError);
      console.error('Full database error details:', dbError instanceof Error ? dbError.stack : JSON.stringify(dbError));
      return NextResponse.json(
        { success: false, error: `Failed to save workout: ${dbError instanceof Error ? dbError.message : 'Database error'}` },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Error generating workout:', error);
    console.error('Full error details:', error instanceof Error ? error.stack : JSON.stringify(error));
    return NextResponse.json({ 
      error: 'Internal server error', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    }, { status: 500 });
  }
}

/**
 * Validate the workout generation request
 */
function validateRequest(body: WorkoutGenerationRequest): string | null {
  // Check muscle focus
  if (!Array.isArray(body.muscle_focus)) {
    return 'muscle_focus must be an array';
  }
  
  if (body.muscle_focus.length > 4) {
    return 'Maximum 4 muscle groups allowed';
  }
  
  // Validate each muscle group
  if (body.muscle_focus.length > 0 && !body.muscle_focus.every(m => ALLOWED_MUSCLES.includes(m.toLowerCase()))) {
    return 'Invalid muscle group';
  }
  
  // Check workout focus
  if (body.workout_focus && !ALLOWED_FOCUS.includes(body.workout_focus.toLowerCase())) {
    return 'Invalid workout focus';
  }
  
  // Check exercise count
  if (typeof body.exercise_count !== 'number' || body.exercise_count < 1 || body.exercise_count > 10) {
    return 'Exercise count must be between 1 and 10';
  }
  
  // Check special instructions length
  if (body.special_instructions && body.special_instructions.length > 140) {
    return 'Special instructions must be 140 characters or less';
  }
  
  return null;
}
