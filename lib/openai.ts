import { OpenAI } from 'openai';
import { WorkoutData } from '@/types/workout';
import { BASE_WORKOUT_PROMPT, RETRY_PROMPT_SUFFIX, focusInstructions } from './prompts/workout';
import { EXERCISE_DATABASE_PROMPT, EXERCISE_DATABASE_RETRY_PROMPT } from './prompts/exercise_database';

// Initialize OpenAI client with better error handling
const initializeOpenAI = () => {
  // Check if API key exists
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not defined in environment variables');
    throw new Error('OpenAI API key is missing');
  }

  console.log('Initializing OpenAI client with API key prefix:', 
    process.env.OPENAI_API_KEY.substring(0, 7) + '...');

  try {
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 60000, // 60 seconds timeout
      maxRetries: 2,  // Retry API calls up to 2 times
      baseURL: "https://api.openai.com/v1", // Explicitly set the base URL
    });
  } catch (error) {
    console.error('Failed to initialize OpenAI client:', error);
    throw error;
  }
};

const openai = initializeOpenAI();

/**
 * Result of workout generation
 */
export interface GenerateWorkoutResult {
  success: boolean;
  data?: WorkoutData;
  error?: string;
  rawResponse?: string;
  parseAttempts?: number;
  generationTimeMs?: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Generate a workout prompt based on user inputs
 * 
 * @param muscleFocus Array of muscle groups to focus on
 * @param workoutFocus Type of workout (hypertrophy, strength, etc)
 * @param exerciseCount Number of exercises to generate
 * @param specialInstructions Any special instructions
 * @param retry Whether this is a retry attempt
 * @param useExerciseDatabase Whether to use the enhanced exercise database prompt
 * @returns The generated prompt
 */
export function generateWorkoutPrompt(
  muscleFocus: string[] = [], 
  workoutFocus: string = 'hypertrophy', 
  exerciseCount: number = 4,
  specialInstructions: string = '',
  retry = false,
  useExerciseDatabase = true
): string {
  // Start with the appropriate base prompt
  let prompt = useExerciseDatabase ? EXERCISE_DATABASE_PROMPT : BASE_WORKOUT_PROMPT;
  
  // If this is a retry, add the appropriate retry suffix
  if (retry) {
    prompt += useExerciseDatabase ? EXERCISE_DATABASE_RETRY_PROMPT : RETRY_PROMPT_SUFFIX;
  }
  
  // Default prompt for random generation
  if (muscleFocus.length === 0) {
    return prompt;
  }
  
  // Get focus-specific instructions
  const focusType = workoutFocus.toLowerCase();
  const specificInstructions = focusInstructions[focusType as keyof typeof focusInstructions] || 
    "Use balanced approach with moderate intensity, focus on proper form and technique.";
  
  // Build the custom prompt with user inputs
  let customPrompt = `You are the fitness scientist god

USER REQUIREMENTS:
- MUSCLE_FOCUS: ${muscleFocus.join(', ')}
- WORKOUT_FOCUS: ${workoutFocus}
- EXERCISE_COUNT: ${exerciseCount}
`;

  // Add special instructions if provided
  if (specialInstructions && specialInstructions.trim()) {
    customPrompt += `- SPECIAL_INSTRUCTIONS: ${specialInstructions.trim()}
`;
  }

  // Add focus-specific instructions
  customPrompt += `
SPECIFIC INSTRUCTIONS FOR ${workoutFocus.toUpperCase()} TRAINING:
${specificInstructions}

ADDITIONAL REQUIREMENTS:
- Exercises HAVE TO be in the correct order according to best practices based on science around ${workoutFocus}
- All exercises must align with correct approach towards workout efficiency
- If there is only one muscleFocus, make sure to propose exercises that will cover different angles
- Do not double exercises if very similar (e.g. bench press and dumbell bench press)
- If WORKOUT_FOCUS is hypertrophy, make sure to propose exercises in correct order for hypertrophy

${prompt}`;

  return customPrompt;
}

/**
 * Validate the workout data structure and values
 * @param data The parsed JSON data
 * @param expectedExerciseCount Optional expected number of exercises
 * @param useExerciseDatabase Whether to validate enhanced exercise database fields
 * @returns Validation result
 */
function validateWorkoutData(data: any, expectedExerciseCount?: number, useExerciseDatabase = true): { valid: boolean; error?: string } {
  // Check if the data has a workout object
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Response is not an object' };
  }
  
  if (!data.workout) {
    return { valid: false, error: 'Missing workout object' };
  }
  
  // Check if the workout has an exercises array
  if (!Array.isArray(data.workout.exercises)) {
    return { valid: false, error: 'Workout does not contain an exercises array' };
  }
  
  // Check if the exercises array is empty
  if (data.workout.exercises.length === 0) {
    return { valid: false, error: 'Exercises array is empty' };
  }
  
  // Check if the exercises count is reasonable compared to expected count
  // Allow for some flexibility - accept if within 2 exercises of requested count
  if (expectedExerciseCount && 
      (data.workout.exercises.length < expectedExerciseCount - 2 || 
       data.workout.exercises.length > expectedExerciseCount + 2)) {
    return { 
      valid: false, 
      error: `Expected around ${expectedExerciseCount} exercises but got ${data.workout.exercises.length}` 
    };
  }
  
  // Check each exercise for required fields
  for (let i = 0; i < data.workout.exercises.length; i++) {
    const exercise = data.workout.exercises[i];
    
    if (!exercise.name || typeof exercise.name !== 'string') {
      return { valid: false, error: `Exercise at index ${i} is missing a name` };
    }
    
    if (typeof exercise.sets !== 'number' || exercise.sets <= 0) {
      return { valid: false, error: `Exercise ${exercise.name} has invalid sets` };
    }
    
    if (typeof exercise.reps !== 'number' || exercise.reps <= 0) {
      return { valid: false, error: `Exercise ${exercise.name} has invalid reps` };
    }
    
    if (typeof exercise.rest_time_seconds !== 'number' || exercise.rest_time_seconds < 0) {
      return { valid: false, error: `Exercise ${exercise.name} has invalid rest time` };
    }
    
    if (!exercise.rationale || typeof exercise.rationale !== 'string') {
      return { valid: false, error: `Exercise ${exercise.name} is missing a rationale` };
    }
    
    // Validate enhanced exercise database fields if required
    if (useExerciseDatabase) {
      // Check primary_muscles
      if (!Array.isArray(exercise.primary_muscles) || exercise.primary_muscles.length === 0) {
        return { valid: false, error: `Exercise ${exercise.name} is missing primary_muscles array` };
      }
      
      // Check secondary_muscles (can be empty array but must be an array)
      if (!Array.isArray(exercise.secondary_muscles)) {
        return { valid: false, error: `Exercise ${exercise.name} is missing secondary_muscles array` };
      }
      
      // Check equipment
      if (!exercise.equipment || typeof exercise.equipment !== 'string') {
        return { valid: false, error: `Exercise ${exercise.name} is missing equipment` };
      }
      
      // Check movement_type
      if (!exercise.movement_type || (exercise.movement_type !== 'compound' && exercise.movement_type !== 'isolation')) {
        return { valid: false, error: `Exercise ${exercise.name} has invalid movement_type` };
      }
    }
  }
  
  return { valid: true };
}

/**
 * Generate a workout using OpenAI
 * 
 * @param muscleFocus Array of muscle groups to focus on
 * @param workoutFocus Type of workout (hypertrophy, strength, etc)
 * @param exerciseCount Number of exercises to generate
 * @param specialInstructions Any special instructions
 * @param retry Whether this is a retry attempt
 * @param useExerciseDatabase Whether to use the enhanced exercise database prompt
 * @returns The generated workout data
 */
export async function generateWorkout(
  muscleFocus: string[] = [], 
  workoutFocus: string = 'hypertrophy', 
  exerciseCount: number = 4,
  specialInstructions: string = '',
  retry = false,
  useExerciseDatabase = true
): Promise<GenerateWorkoutResult> {
  const startTime = Date.now();
  let parseAttempts = 1;
  
  try {
    console.log('Starting workout generation with parameters:', {
      muscleFocus,
      workoutFocus,
      exerciseCount,
      specialInstructionsLength: specialInstructions?.length || 0,
      retry,
      useExerciseDatabase
    });

    // Generate the prompt
    const prompt = generateWorkoutPrompt(
      muscleFocus, 
      workoutFocus, 
      exerciseCount, 
      specialInstructions,
      retry,
      useExerciseDatabase
    );
    
    // Debug log
    console.log('Sending prompt to OpenAI:', prompt.substring(0, 100) + '...');
    
    // Calculate max_tokens based on exercise count (more exercises need more tokens)
    const baseTokens = 1000;
    const tokensPerExercise = 200;
    const maxTokens = Math.min(4000, baseTokens + (exerciseCount * tokensPerExercise));
    
    console.log(`Using max_tokens=${maxTokens} for ${exerciseCount} exercises`);
    
    // Verify OpenAI client is properly initialized
    if (!openai) {
      throw new Error('OpenAI client is not initialized');
    }

    console.log('Attempting to call OpenAI API...');
    
    // Call OpenAI API with timeout and better error handling
    let response;
    try {
      response = await Promise.race([
        openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'system', content: prompt }],
          temperature: 0.7,
          max_tokens: maxTokens,
          response_format: { type: "json_object" }, // Ensure response is valid JSON
        }),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('OpenAI API timeout')), 30000)
        )
      ]);
      console.log('Successfully received response from OpenAI');
    } catch (apiError) {
      console.error('Error calling OpenAI API:', apiError);
      if (apiError instanceof Error) {
        console.error('Error details:', apiError.message);
        if ('status' in apiError) {
          console.error('API status code:', (apiError as any).status);
        }
      }
      throw apiError;
    }
    
    // Extract and parse JSON from response
    const responseText = response.choices[0].message.content || '';
    
    try {
      // Try to parse the entire response as JSON
      let jsonStr = responseText.trim();
      let parsedData;
      
      try {
        // First attempt: parse the entire response
        parsedData = JSON.parse(jsonStr);
      } catch (parseError) {
        console.log('First parse attempt failed, trying to extract JSON...');
        
        // Second attempt: try to extract JSON from the response using regex
        const jsonMatch = responseText.match(/\{[\s\S]*\}/m);
        if (!jsonMatch) {
          // Third attempt: look for code blocks that might contain JSON
          const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (codeBlockMatch && codeBlockMatch[1]) {
            console.log('Found JSON in code block, attempting to parse...');
            jsonStr = codeBlockMatch[1].trim();
            parsedData = JSON.parse(jsonStr);
          } else {
            throw new Error('Could not find JSON in response');
          }
        } else {
          jsonStr = jsonMatch[0];
          parsedData = JSON.parse(jsonStr);
        }
        parseAttempts++;
      }
      
      // Validate the parsed data
      let validationResult = validateWorkoutData(parsedData, exerciseCount, useExerciseDatabase);
      
      // If validation fails with exercise database fields, try validating without them
      if (!validationResult.valid && useExerciseDatabase) {
        console.log(`Validation failed with exercise database fields: ${validationResult.error}`);
        console.log('Trying validation without exercise database fields...');
        validationResult = validateWorkoutData(parsedData, exerciseCount, false);
        
        if (validationResult.valid) {
          console.log('Validation succeeded without exercise database fields');
        }
      }
      
      if (!validationResult.valid) {
        throw new Error(`Validation failed: ${validationResult.error}`);
      }
      
      // Return success result
      return {
        success: true,
        data: parsedData.workout,
        rawResponse: responseText,
        parseAttempts,
        generationTimeMs: Date.now() - startTime,
        usage: {
          promptTokens: response.usage?.prompt_tokens || 0,
          completionTokens: response.usage?.completion_tokens || 0,
          totalTokens: response.usage?.total_tokens || 0,
        },
      };
    } catch (parseError) {
      console.error('Failed to parse OpenAI response:', parseError);
      console.error('Raw response:', responseText);
      
      // If this is already a retry, give up
      if (retry) {
        return {
          success: false,
          error: `Failed to parse response after retry: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`,
          rawResponse: responseText,
          parseAttempts,
          generationTimeMs: Date.now() - startTime,
        };
      }
      
      // Retry with a more explicit prompt
      console.log('Retrying with more explicit prompt...');
      parseAttempts++;
      return generateWorkout(muscleFocus, workoutFocus, exerciseCount, specialInstructions, true, useExerciseDatabase);
    }
  } catch (error) {
    console.error('OpenAI API error:', error);
    return {
      success: false,
      error: `OpenAI API error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      parseAttempts,
      generationTimeMs: Date.now() - startTime,
    };
  }
}
