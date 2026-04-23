import pytest

@pytest.fixture
def sample_fixture():
    """Sample fixture for testing."""
    return {"key": "value"}

@pytest.fixture
def mock_data():
    """Mock data for testing."""
    return [1, 2, 3, 4, 5]
