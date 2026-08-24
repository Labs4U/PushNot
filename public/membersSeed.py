import boto3
import random
from decimal import Decimal

# ⚠️ Configuration
TABLE_NAME = "PushNotSystem-oelmemu3trbujlx5bcvzmfj3gi-NONE"
REGION_NAME = "us-east-1"
ASSOCIATION_ID = "ASSOC#101"
NUMBER_OF_MEMBERS = 50  # Change this to generate more or fewer members

# 🎲 Data Arrays for Randomization
MALE_NAMES = ["Ahmed", "Mohamed", "Omar", "Khalid", "Hussain", "Isa", "Ali", "Hassan", "Sayed", "Yusuf"]
FEMALE_NAMES = ["Fatima", "Zainab", "Noor", "Mariam", "Aisha", "Sara", "Huda", "Mona", "Amira", "Layla"]
LAST_NAMES = ["Ali", "Hassan", "Amin", "Yusuf", "Salman", "Ebrahim", "Jassim", "Tariq", "Adel", "Majeed"]
REGIONS = ["A'ali", "Manama", "Muharraq", "Riffa", "Isa Town", "Hamad Town", "Sitra", "Budaiya"]
PERSONAS = ["CLICKER", "CHATTER", "PASSIVE"]

def seed_random_members():
    dynamodb = boto3.resource('dynamodb', region_name=REGION_NAME)
    table = dynamodb.Table(TABLE_NAME)

    print(f"Generating and seeding {NUMBER_OF_MEMBERS} members into {TABLE_NAME}...")
    
    success_count = 0

    # We will use DynamoDB's batch_writer for faster, efficient bulk inserts
    with table.batch_writer() as batch:
        for i in range(1, NUMBER_OF_MEMBERS + 1):
            # 1. Generate Demographics
            gender = random.choice(["MALE", "FEMALE"])
            first_name = random.choice(MALE_NAMES) if gender == "MALE" else random.choice(FEMALE_NAMES)
            last_name = random.choice(LAST_NAMES)
            full_name = f"{first_name} {last_name}"
            
            # Generate a sequential phone number starting from 97333000000
            phone = f"9733300{i:04d}" 
            region = random.choice(REGIONS)
            persona = random.choice(PERSONAS)

            # 2. Generate Realistic Stats
            # Engagement between 0 and 100
            engagement = round(random.uniform(0, 100), 1)
            
            # Conversion should logically be less than or equal to engagement
            conversion = round(random.uniform(0, engagement), 1) 
            
            # Lifetime contribution correlates with conversion (if 0%, then 0. Else 10 to 5000)
            if conversion < 1.0:
                lifetime = 0.0
            else:
                lifetime = round(random.uniform(10, 5000), 1)

            # 3. Construct the DynamoDB Item
            item = {
                "pk": ASSOCIATION_ID,
                "sk": f"MEM#{phone}",
                "entityType": "MEMBER",
                "__typename": "PushNotSystem",  # 🟢 CRITICAL: Required for Amplify/AppSync to see the data
                "name": full_name,
                "phone": phone,
                "address": region,
                "gender": gender,
                # Cast floats to Decimal for boto3 compatibility
                "engagementRatePercent": Decimal(str(engagement)),
                "conversionRatePercent": Decimal(str(conversion)),
                "lifetimeContributionAmount": Decimal(str(lifetime)),
                "interactionPersona": persona
            }

            try:
                batch.put_item(Item=item)
                success_count += 1
                if success_count % 10 == 0:
                    print(f"✅ Queued {success_count} members...")
            except Exception as e:
                print(f"❌ Failed to queue {full_name}: {str(e)}")

    print(f"\n🎉 Successfully seeded {success_count}/{NUMBER_OF_MEMBERS} members!")

if __name__ == "__main__":
    seed_random_members()