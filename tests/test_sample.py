def test_sample(sample_fixture):
    """Test using the sample fixture."""
    assert sample_fixture["key"] == "value"

def test_mock_data(mock_data):
    """Test using the mock data fixture."""
    assert len(mock_data) == 5
    assert 3 in mock_data
