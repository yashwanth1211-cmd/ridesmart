
"""RideSmart experimental ML model for ETA prediction.

Uses synthetic training examples for demonstration.
This model is experimental and is not validated against
real bus arrival times.
"""

from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestRegressor


MODEL_PATH = Path(__file__).with_name("eta_ml_model.joblib")


def create_training_data(seed=42, samples=1000):
    """Generate synthetic training data."""
    rng = np.random.default_rng(seed)

    progress = rng.uniform(0.0, 0.95, samples)
    segment_time = rng.uniform(60.0, 600.0, samples)
    speed = rng.uniform(5.0, 45.0, samples)

    remaining_fraction = 1.0 - progress

    target = (
        remaining_fraction
        * segment_time
        * 4.0
        * (26.0 / np.maximum(speed, 4.0))
        + rng.normal(0.0, 15.0, samples)
    )

    target = np.maximum(target, 0.0)

    features = np.column_stack(
        [remaining_fraction, segment_time, speed]
    )

    return features, target


def train_model():
    """Train and save the experimental Random Forest model."""
    features, targets = create_training_data()

    model = RandomForestRegressor(
        n_estimators=100,
        random_state=42,
        min_samples_leaf=3,
    )

    model.fit(features, targets)
    joblib.dump(model, MODEL_PATH)

    return model


def load_model():
    """Load the saved model or train it if it does not exist."""
    if MODEL_PATH.exists():
        return joblib.load(MODEL_PATH)

    return train_model()


def predict_eta_ml(
    progress: float,
    average_segment_time: float,
    current_speed_kmph: float,
) -> dict:
    """Predict experimental remaining travel time in seconds."""
    progress = max(0.0, min(1.0, float(progress)))
    average_segment_time = max(
        0.0, float(average_segment_time)
    )
    current_speed_kmph = max(
        4.0, float(current_speed_kmph)
    )

    model = load_model()

    features = np.array([[
        1.0 - progress,
        average_segment_time,
        current_speed_kmph,
    ]])

    eta_seconds = max(
        0, round(float(model.predict(features)[0]))
    )

    return {
        "eta_seconds": eta_seconds,
        "method": "experimental_random_forest",
        "validated": False,
    }
